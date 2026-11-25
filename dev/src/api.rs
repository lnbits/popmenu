use crate::{decimal::Decimal, host, input::*, lnbits::extension::utils_currencies, orders, Reply};
use serde_json::{json, Value};

pub use orders::{
    cancel_order, complete_order, create_order, get_order_confirmation, handle_invoice_paid,
    list_orders, mark_manual_paid, retry_payment,
};
pub fn list_wallets(_: &Value) -> Reply {
    let mut wallets = host::wallets();
    for w in &mut wallets {
        if w.get("currency").is_none() {
            w["currency"] = Value::Null;
        }
    }
    Ok(json!({"wallets":wallets}))
}
pub fn list_currencies(_: &Value) -> Reply {
    Ok(json!({"currencies":currencies()}))
}
pub fn create_menu(r: &Value) -> Reply {
    save_menu(r, true)
}
pub fn update_menu(r: &Value) -> Reply {
    save_menu(r, false)
}
pub fn list_menus(r: &Value) -> Reply {
    let p = host::page("menus", page_options(r)?)?;
    let menus:Vec<_>=p.rows.iter().map(|m|{let mut v=menu_view(m);
    merge(&mut v,json!({"walletId":m["wallet_id"],"createdAt":m["created_at"],"updatedAt":m["updated_at"]}));v}).collect();
    Ok(json!({"menus":menus,"total":p.total}))
}
pub fn list_items(r: &Value) -> Reply {
    let menu = menu(r)?;
    let p = items(s(&menu["id"]))?;
    Ok(json!({"items":p.rows.iter().map(|i|item_view(i,true)).collect::<Vec<_>>(),"total":p.total}))
}
pub fn create_item(r: &Value) -> Reply {
    save_item(r, true)
}
pub fn update_item(r: &Value) -> Reply {
    save_item(r, false)
}
pub fn get_public_menu(r: &Value) -> Reply {
    let row = menu(r)?;
    if row["active"] != true {
        return Err("This menu is not active.".into());
    }
    let mut public = menu_view(&row);
    public["items"] = json!(items(s(&row["id"]))?
        .rows
        .iter()
        .filter(|i| i["active"] == true)
        .map(|i| item_view(i, false))
        .collect::<Vec<_>>());
    Ok(json!({"menu":public,"checkoutToken":host::id("checkout")}))
}
pub fn menu(r: &Value) -> Reply {
    load("menus", alias(r, "menuId", "menu_id"), "menuId", "Menu")
}
pub fn load(table: &str, value: &Value, field: &str, name: &str) -> Reply {
    let id = id(value, field)?;
    let row = host::get(table, &id)?;
    if row.is_null() || row["id"] != *value {
        Err(format!("{name} not found."))
    } else {
        Ok(row)
    }
}
pub fn items(menu: &str) -> Result<host::Page, String> {
    let mut p = host::page("items", json!({"filters":{"menu_id":menu},"limit":100}))?;
    p.rows.sort_by_key(|r| {
        (
            r["position"].as_u64().unwrap_or(0),
            r["created_at"].as_u64().unwrap_or(0),
        )
    });
    Ok(p)
}
pub fn page_options(r: &Value) -> Reply {
    Ok(
        json!({"limit":int(r.get("limit").unwrap_or(&json!(100)),"limit",1,100)?,"offset":int(r.get("offset").unwrap_or(&json!(0)),"offset",0,1000000)?}),
    )
}
fn currencies() -> Vec<String> {
    let mut c = utils_currencies::list_currencies().currencies;
    if !c.iter().any(|c| c == "sat") {
        c.insert(0, "sat".into());
    }
    c
}
fn menu_view(m: &Value) -> Value {
    json!({"id":m["id"],"name":m["name"],"description":s(&m["description"]),"currency":m["currency"],"lightningEnabled":m["lightning_enabled"]==true,"manualEnabled":m["manual_enabled"]==true,"manualInstructions":s(&m["manual_instructions"]),"active":m["active"]==true})
}
fn item_view(i: &Value, private: bool) -> Value {
    let mut v = json!({"id":i["id"],"menuId":i["menu_id"],"name":i["name"],"description":s(&i["description"]),"price":i["price"],"position":i["position"],"active":i["active"]==true,"soldOut":i["sold_out"]==true});
    if private {
        v["createdAt"] = i["created_at"].clone();
        v["updatedAt"] = i["updated_at"].clone();
    }
    v
}
fn save_menu(r: &Value, new: bool) -> Reply {
    let mut row = if new { json!({}) } else { menu(r)? };
    let mut data = row.clone();
    merge(&mut data, r.clone());
    let wanted = text(&data["currency"], "currency", 8, true)?;
    let currency = currencies()
        .into_iter()
        .find(|c| c.eq_ignore_ascii_case(&wanted))
        .ok_or("That currency is not supported.")?;
    let wallet = text(alias(&data, "walletId", "wallet_id"), "walletId", 128, true)?;
    if !host::wallets().iter().any(|w| w["id"] == wallet) {
        return Err("The selected wallet is not available.".into());
    }
    let flag = |a, b, default| boolean(data.get(a).or_else(|| data.get(b)), a, default);
    let lightning = flag("lightningEnabled", "lightning_enabled", true)?;
    let manual = flag("manualEnabled", "manual_enabled", false)?;
    if !lightning && !manual {
        return Err("At least one payment method must be enabled.".into());
    }
    let now = host::now();
    merge(
        &mut row,
        json!({"name":text(&data["name"],"name",120,true)?,"description":text(&data["description"],"description",1000,false)?,"currency":currency,"wallet_id":wallet,"lightning_enabled":lightning,"manual_enabled":manual,
        "manual_instructions":text(alias(&data,"manualInstructions","manual_instructions"),"manualInstructions",1000,false)?,"active":boolean(data.get("active"),"active",true)?,"updated_at":now}),
    );
    if new {
        row["id"] = json!(host::id("menu"));
        row["created_at"] = json!(now);
    }
    host::set("menus", &row)?;
    Ok(json!({"menu":row}))
}
fn save_item(r: &Value, new: bool) -> Reply {
    let now = host::now();
    let mut row = if new {
        let m = menu(r)?;
        json!({"id":host::id("item"),"menu_id":m["id"],"created_at":now})
    } else {
        load("items", alias(r, "itemId", "item_id"), "itemId", "Item")?
    };
    for (key, limit, required) in [("name", 120, true), ("description", 1000, false)] {
        if new || r.get(key).is_some() {
            row[key] = json!(text(&r[key], key, limit, required)?);
        }
    }
    if new || r.get("price").is_some() {
        row["price"] = json!(Decimal::parse(&r["price"], "price")?.canonical());
    }
    if new || r.get("position").is_some() {
        row["position"] = json!(int(
            r.get("position").unwrap_or(&json!(0)),
            "position",
            0,
            1000000
        )?);
    }
    for (a, b, default) in [("active", "active", true), ("soldOut", "sold_out", false)] {
        let v = r.get(a).or_else(|| r.get(b));
        if new || v.is_some() {
            row[b] = json!(boolean(v, a, default)?);
        }
    }
    row["updated_at"] = json!(now);
    host::set("items", &row)?;
    Ok(json!({"item":item_view(&row,true)}))
}
