use crate::{
    api, decimal::Decimal, host, input::*, lnbits::extension::utils_lightning as lightning, Reply,
};
use serde_json::{json, Value};
use std::collections::BTreeSet;
const ORDERS: &str = "orders";
const ATTEMPTS: &str = "payment_attempts";
const SETTLED: &str = "settlements";
pub fn list_orders(r: &Value) -> Reply {
    let mut opts = api::page_options(r)?;
    let mut filters = json!({});
    let menu = alias(r, "menuId", "menu_id");
    if !s(menu).is_empty() {
        filters["menu_id"] = json!(id(menu, "menuId")?);
    }
    if !s(&r["status"]).is_empty() {
        filters["status"] = json!(text(&r["status"], "status", 30, true)?);
    }
    merge(
        &mut opts,
        json!({"filters":filters,"sortBy":"created_at","descending":true}),
    );
    let p = host::page(ORDERS, opts)?;
    let mut rows = p
        .rows
        .into_iter()
        .map(expire)
        .collect::<Result<Vec<_>, _>>()?;
    rows.sort_by_key(|r| {
        (
            match s(&r["status"]) {
                "paid" => 0,
                "manual_pending" => 1,
                "pending_payment" => 2,
                _ => 3,
            },
            std::cmp::Reverse(r["created_at"].as_u64().unwrap_or(0)),
        )
    });
    Ok(json!({"orders":rows.iter().map(private).collect::<Result<Vec<_>,_>>()?,"total":p.total}))
}
pub fn mark_manual_paid(r: &Value) -> Reply {
    transition(r, "paid")
}
pub fn complete_order(r: &Value) -> Reply {
    transition(r, "completed")
}
pub fn cancel_order(r: &Value) -> Reply {
    transition(r, "cancelled")
}
pub fn get_order_confirmation(r: &Value) -> Reply {
    confirmation(expire(order(r)?)?)
}
pub fn create_order(r: &Value) -> Reply {
    let menu = api::menu(r)?;
    if menu["active"] != true {
        return Err("This menu is not active.".into());
    }
    let token = id(alias(r, "checkoutToken", "checkout_token"), "checkoutToken")?;
    let existing = host::page(
        ORDERS,
        json!({"filters":{"checkout_token":token},"limit":2}),
    )?;
    if let Some(row) = existing.rows.into_iter().next() {
        if row["menu_id"] != menu["id"] {
            return Err("Checkout token does not belong to this menu.".into());
        }
        return confirmation(expire(row)?);
    }
    let method = text(
        alias(r, "paymentMethod", "payment_method"),
        "paymentMethod",
        20,
        true,
    )?
    .to_lowercase();
    let manual = match method.as_str() {
        "manual" if menu["manual_enabled"] != true => {
            return Err("Manual payment is not enabled for this menu.".into())
        }
        "lightning" if menu["lightning_enabled"] != true => {
            return Err("Lightning payment is not enabled for this menu.".into())
        }
        "manual" => true,
        "lightning" => false,
        _ => return Err("Payment method is invalid.".into()),
    };
    let raw = r["items"]
        .as_array()
        .filter(|rows| (1..=100).contains(&rows.len()))
        .ok_or("At least one cart item is required.")?;
    let available = api::items(s(&menu["id"]))?.rows;
    let mut items = Vec::new();
    let mut seen = BTreeSet::new();
    let mut total = Decimal::default();
    for entry in raw {
        if !entry.is_object() {
            return Err("Cart items are invalid.".into());
        }
        let key = id(
            first(&[alias(entry, "itemId", "item_id"), &entry["id"]]),
            "itemId",
        )?;
        if !seen.insert(key.clone()) {
            return Err("Cart contains a duplicate item.".into());
        }
        let row = available
            .iter()
            .find(|i| i["id"] == key && i["menu_id"] == menu["id"])
            .ok_or("A cart item is not part of this menu.")?;
        if row["active"] != true || row["sold_out"] == true {
            return Err("A cart item is no longer available.".into());
        }
        let qty = int(&entry["quantity"], "quantity", 1, 99)?;
        let price = Decimal::parse(&row["price"], "price")?;
        total.add_times(&price, qty as u32);
        items.push(json!({"item_id":key,"name":row["name"],"price":price.canonical(),"quantity":qty,"note":text(&entry["note"],"item note",500,false)?}));
    }
    let now = host::now();
    let mut row = json!({"id":host::id("order"),"checkout_token":token,"menu_id":menu["id"],"order_number":host::id("receipt"),"items":items,"total":total.canonical(),"currency":menu["currency"],
        "payment_method":method,"payment_status":if manual{"manual_pending"}else{"pending"},"status":if manual{"manual_pending"}else{"pending_payment"},"fulfillment_status":"unfulfilled",
        "manual_instructions":if manual{json!(s(&menu["manual_instructions"]))}else{Value::Null},"attempt_id":null,"created_at":now,"updated_at":now,"paid_at":null,"completed_at":null,"cancelled_at":null});
    for (camel, snake, max) in [
        ("customerName", "customer_name", 120),
        ("customerNote", "customer_note", 1000),
        ("tableLabel", "table_label", 120),
        ("locationLabel", "location_label", 120),
    ] {
        row[snake] = json!(text(alias(r, camel, snake), camel, max, false)?);
    }
    if manual {
        host::set(ORDERS, &row)?;
        return Ok(json!({"order":public(&row)}));
    }
    let attempt = match new_attempt(&row) {
        Ok(a) => a,
        Err(_) => {
            merge(
                &mut row,
                json!({"status":"expired","payment_status":"expired","updated_at":host::now()}),
            );
            host::set(ORDERS, &row)?;
            return Ok(invoice_response(&row, &Value::Null));
        }
    };
    attach(row, attempt)
}
pub fn retry_payment(r: &Value) -> Reply {
    let row = expire(order(r)?)?;
    if row["payment_method"] != "lightning" {
        return Err("Only Lightning orders can be retried.".into());
    }
    if matches!(s(&row["status"]), "paid" | "completed") {
        return Err("This order is already paid.".into());
    }
    if row["status"] != "expired" {
        return Err("The current invoice has not expired.".into());
    }
    let menu = api::load("menus", &row["menu_id"], "menuId", "Menu")?;
    if menu["active"] != true || menu["lightning_enabled"] != true {
        return Err("Lightning payment is not currently available.".into());
    }
    let attempt = new_attempt(&row)?;
    attach(row, attempt)
}
pub fn handle_invoice_paid(e: &Value) -> Reply {
    let p = &e["payment"];
    let ex = &e["extra"];
    let pe = &p["extra"];
    let hash = text(
        first(&[
            &e["paymentHash"],
            &e["payment_hash"],
            &p["paymentHash"],
            &p["payment_hash"],
        ]),
        "paymentHash",
        200,
        true,
    )?;
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Payment hash is invalid.".into());
    }
    if first(&[&e["extension"], &p["extension"]]) != "popmenu"
        || first(&[&e["tag"], &p["tag"], &ex["tag"]]) != "popmenu"
        || e["pending"] == true
        || p["pending"] == true
        || first(&[&e["status"], &p["status"]]) != "success"
    {
        return Err("Payment event is not a confirmed PopMenu settlement.".into());
    }
    let nested = first(&[&ex["extra_popmenu"], &pe["extra_popmenu"]]);
    let parsed;
    let nested = if let Some(raw) = nested.as_str() {
        parsed = serde_json::from_str(raw).unwrap_or(Value::Null);
        &parsed
    } else {
        nested
    };
    let mut row = api::load(
        ORDERS,
        first(&[&nested["order_id"], &ex["order_id"], &pe["order_id"]]),
        "orderId",
        "Order",
    )?;
    let attempt_id = id(
        first(&[&nested["attempt_id"], &ex["attempt_id"], &pe["attempt_id"]]),
        "attemptId",
    )?;
    if first(&[&ex["source_id"], &pe["source_id"]]) != &row["menu_id"] {
        return Err("Payment event source does not match this menu.".into());
    }
    let mut attempt = host::get(ATTEMPTS, &attempt_id)?;
    if attempt.is_null() || attempt["order_id"] != row["id"] || attempt["payment_hash"] != hash {
        return Err("Payment event does not match this order.".into());
    }
    let currency = s(first(&[&e["currency"], &p["currency"]]));
    if !currency.is_empty() && !currency.eq_ignore_ascii_case(s(&attempt["currency"])) {
        return Err("Payment currency does not match this order.".into());
    }
    let amount = if e["amount"].is_null() {
        &p["amount"]
    } else {
        &e["amount"]
    };
    if !amount.as_u64().is_some_and(|n| {
        n > 0 && n <= 9007199254740991 && Some(n) == attempt["amount_msat"].as_u64()
    }) {
        return Err("Payment amount does not match this order.".into());
    }
    let settlement = host::get(SETTLED, &hash)?;
    if !settlement.is_null()
        && (settlement["order_id"] != row["id"]
            || settlement["attempt_id"] != attempt["id"]
            || settlement["amount_msat"] != attempt["amount_msat"])
    {
        return Err("Payment settlement conflicts with this order.".into());
    }
    if !settlement.is_null() && row["payment_status"] == "paid" {
        return Ok(json!({"settled":true,"order":public(&row)}));
    }
    if !matches!(s(&row["status"]), "pending_payment" | "expired") {
        return Err("This order was already settled or is no longer payable.".into());
    }
    let now = settlement["paid_at"].as_u64().unwrap_or_else(host::now);
    if settlement.is_null() {
        host::set(
            SETTLED,
            &json!({"id":hash,"order_id":row["id"],"attempt_id":attempt["id"],"menu_id":row["menu_id"],"amount":attempt["amount"],"amount_msat":attempt["amount_msat"],"paid_at":now}),
        )?;
    }
    merge(&mut attempt, json!({"status":"paid","paid_at":now}));
    host::set(ATTEMPTS, &attempt)?;
    merge(
        &mut row,
        json!({"status":"paid","payment_status":"paid","paid_at":now,"updated_at":now}),
    );
    host::set(ORDERS, &row)?;
    Ok(json!({"settled":true,"order":public(&row)}))
}
fn order(r: &Value) -> Reply {
    api::load(ORDERS, alias(r, "orderId", "order_id"), "orderId", "Order")
}
fn transition(r: &Value, state: &str) -> Reply {
    let mut row = order(r)?;
    let now = host::now();
    match state {
        "paid" => {
            if row["payment_method"] != "manual" || row["status"] != "manual_pending" {
                return Err("Only pending manual orders can be marked paid.".into());
            }
            merge(
                &mut row,
                json!({"payment_status":"paid","fulfillment_status":"unfulfilled","paid_at":now}),
            );
        }
        "completed" => {
            if !matches!(s(&row["status"]), "paid" | "manual_pending") {
                return Err("This order cannot be completed in its current state.".into());
            }
            merge(
                &mut row,
                json!({"fulfillment_status":"completed","completed_at":now}),
            );
        }
        _ => {
            if matches!(s(&row["status"]), "paid" | "completed") || row["payment_status"] == "paid"
            {
                return Err("Paid orders cannot be cancelled.".into());
            }
            if !matches!(
                s(&row["status"]),
                "pending_payment" | "manual_pending" | "expired"
            ) {
                return Err("This order cannot be cancelled.".into());
            }
            merge(
                &mut row,
                json!({"payment_status":"cancelled","cancelled_at":now}),
            );
        }
    }
    merge(&mut row, json!({"updated_at":now,"status":state}));
    host::set(ORDERS, &row)?;
    Ok(json!({"order":private(&row)?}))
}
fn new_attempt(row: &Value) -> Reply {
    let id = host::id("attempt");
    let amount = s(&row["total"]).parse::<f64>().unwrap_or(f64::INFINITY);
    if !amount.is_finite() || amount <= 0. || amount > 9007199254740991. {
        return Err("The total is outside the supported invoice range.".into());
    }
    let inv = host::invoice(
        s(&row["menu_id"]),
        amount,
        s(&row["currency"]),
        &format!("PopMenu order {}", s(&row["order_number"])),
        vec![
            ("order_id".into(), s(&row["id"]).into()),
            ("attempt_id".into(), id.clone()),
            ("checkout_token".into(), s(&row["checkout_token"]).into()),
        ],
    );
    if s(&inv["paymentHash"]).is_empty() || s(&inv["paymentRequest"]).is_empty() {
        return Err("Invoice creation failed.".into());
    }
    let bolt = lightning::Bolt11Request {
        bolt11: s(&inv["paymentRequest"]).into(),
    };
    let valid = |v: Option<u64>| v.filter(|n| *n > 0 && *n <= 9007199254740991);
    let expires = valid(lightning::invoice_expiry(&bolt).expires_at)
        .ok_or("The invoice has no valid expiry.")?;
    let msat = valid(lightning::invoice_amount_msat(&bolt).amount_msat)
        .ok_or("The invoice has no valid amount.")?;
    if s(&row["currency"]).eq_ignore_ascii_case("sat") {
        let mut expected = Decimal::default();
        expected.add_times(&Decimal::parse(&row["total"], "total")?, 1000);
        if expected.canonical() != msat.to_string() {
            return Err("The invoice amount does not match the order total.".into());
        }
    }
    Ok(
        json!({"id":id,"order_id":row["id"],"menu_id":row["menu_id"],"payment_hash":inv["paymentHash"],"checking_id":inv["checkingId"],"bolt11":inv["paymentRequest"],"amount":row["total"],"amount_msat":msat,"currency":row["currency"],"expires_at":expires,"status":"pending","created_at":host::now(),"paid_at":null}),
    )
}
fn attach(mut row: Value, attempt: Value) -> Reply {
    host::set(ATTEMPTS, &attempt)?;
    merge(
        &mut row,
        json!({"status":"pending_payment","payment_status":"pending","attempt_id":attempt["id"],"updated_at":host::now()}),
    );
    host::set(ORDERS, &row)?;
    Ok(invoice_response(&row, &attempt))
}
fn expire(mut row: Value) -> Reply {
    if row["status"] == "pending_payment" && row["attempt_id"].is_string() {
        let mut a = host::get(ATTEMPTS, s(&row["attempt_id"]))?;
        if a["status"] == "pending"
            && a["expires_at"]
                .as_u64()
                .is_some_and(|t| t > 0 && t <= host::now())
        {
            a["status"] = json!("expired");
            host::set(ATTEMPTS, &a)?;
            merge(
                &mut row,
                json!({"status":"expired","payment_status":"expired","updated_at":host::now()}),
            );
            host::set(ORDERS, &row)?;
        }
    }
    Ok(row)
}
fn confirmation(row: Value) -> Reply {
    let a = if row["status"] == "pending_payment" && row["attempt_id"].is_string() {
        host::get(ATTEMPTS, s(&row["attempt_id"]))?
    } else {
        Value::Null
    };
    Ok(invoice_response(
        &row,
        if a["status"] == "pending" {
            &a
        } else {
            &Value::Null
        },
    ))
}
fn invoice_response(row: &Value, a: &Value) -> Value {
    json!({"order":public(row),"paymentRequest":s(&a["bolt11"]),"paymentHash":s(&a["payment_hash"]),"expiresAt":a["expires_at"]})
}
fn private(row: &Value) -> Reply {
    let mut v = public(row);
    v["attemptId"] = row["attempt_id"].clone();
    if row["payment_method"] == "lightning" && row["attempt_id"].is_string() {
        let a = host::get(ATTEMPTS, s(&row["attempt_id"]))?;
        if a["bolt11"].is_string() {
            v["paymentRequest"] = a["bolt11"].clone();
        }
    }
    Ok(v)
}
fn public(row: &Value) -> Value {
    let mut v = json!({"id":row["id"],"orderNumber":row["order_number"],"menuId":row["menu_id"],"items":row["items"],"total":row["total"],"currency":row["currency"],
        "paymentMethod":row["payment_method"],"paymentStatus":row["payment_status"],"status":row["status"],"fulfillmentStatus":s(&row["fulfillment_status"]),"customerName":s(&row["customer_name"]),
        "customerNote":s(&row["customer_note"]),"tableLabel":s(&row["table_label"]),"locationLabel":s(&row["location_label"]),"createdAt":row["created_at"],"paidAt":row["paid_at"],
        "completedAt":row["completed_at"],"cancelledAt":row["cancelled_at"],"manualInstructions":s(&row["manual_instructions"])});
    if row["payment_status"] == "paid" {
        let input = format!("popmenu:{}:{}", s(&row["id"]), s(&row["order_number"]));
        let hash = input.encode_utf16().fold(2166136261u32, |h, c| {
            (h ^ u32::from(c)).wrapping_mul(16777619)
        });
        let digits = format!("{:06}", hash % 1000000);
        v["paymentPin"] = json!(format!("{}-{}", &digits[..3], &digits[3..]));
    }
    v
}
