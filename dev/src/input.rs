use serde_json::Value;
pub fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub fn alias<'a>(r: &'a Value, a: &str, b: &str) -> &'a Value {
    r.get(a).unwrap_or(&r[b])
}
pub fn text(v: &Value, name: &str, max: usize, required: bool) -> Result<String, String> {
    let s = s(v).trim();
    if required && s.is_empty() {
        return Err(format!("{name} is required."));
    }
    if s.encode_utf16().count() > max {
        return Err(format!("{name} is too long."));
    }
    Ok(s.into())
}
pub fn id(v: &Value, name: &str) -> Result<String, String> {
    text(v, name, 160, true)
}
pub fn int(v: &Value, name: &str, min: u64, max: u64) -> Result<u64, String> {
    let n = if let Some(s) = v
        .as_str()
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
    {
        s.parse().ok()
    } else {
        v.as_u64().or_else(|| {
            v.as_f64()
                .filter(|n| *n >= 0. && n.fract() == 0.)
                .map(|n| n as u64)
        })
    };
    n.filter(|n| (min..=max).contains(n))
        .ok_or_else(|| format!("{name} is invalid."))
}
pub fn boolean(v: Option<&Value>, name: &str, d: bool) -> Result<bool, String> {
    v.map_or(Ok(d), |v| {
        v.as_bool()
            .ok_or_else(|| format!("{name} must be a boolean."))
    })
}
pub fn merge(row: &mut Value, extra: Value) {
    if let (Some(row), Value::Object(fields)) = (row.as_object_mut(), extra) {
        row.extend(fields);
    }
}
pub fn first<'a>(values: &[&'a Value]) -> &'a Value {
    values
        .iter()
        .copied()
        .find(|v| !v.is_null() && v.as_str() != Some(""))
        .unwrap_or(&Value::Null)
}
