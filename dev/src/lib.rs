mod api;
mod decimal;
mod host;
mod input;
mod orders;

use serde_json::{json, Value};

wit_bindgen::generate!({ path: "../wasm/lnbits-extension.wit", world: "popmenu", generate_all });
struct Extension;

type Reply = Result<Value, String>;

fn run(input: &str, handler: fn(&Value) -> Reply) -> String {
    let request = if input.is_empty() {
        Ok(json!({}))
    } else {
        serde_json::from_str(input)
    };
    let result = match request {
        Ok(value) if value.is_object() => handler(&value),
        _ => Err("request must be a JSON object.".into()),
    };
    match result {
        Ok(data) => json!({"ok": true, "data": data}),
        Err(error) => json!({"ok": false, "error": error}),
    }
    .to_string()
}

// Each WIT export has the same JSON envelope.
macro_rules! routes {
    ($($name:ident),+ $(,)?) => {
        impl Guest for Extension {
            $(fn $name(input:String) -> String { run(&input, api::$name) })+
        }
    };
}
routes!(
    list_currencies,
    list_wallets,
    list_menus,
    create_menu,
    update_menu,
    list_items,
    create_item,
    update_item,
    list_orders,
    mark_manual_paid,
    complete_order,
    cancel_order,
    get_public_menu,
    create_order,
    get_order_confirmation,
    retry_payment,
    handle_invoice_paid
);
export!(Extension);
