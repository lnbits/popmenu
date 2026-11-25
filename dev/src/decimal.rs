use serde_json::Value;

// Base-ten digits in little-endian order, with eight fractional places.
// Menu prices have no fixed bound on their integer part.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct Decimal(Vec<u8>);
impl Decimal {
    pub fn parse(v: &Value, name: &str) -> Result<Self, String> {
        let raw = match v {
            Value::Number(n) => n.to_string(),
            Value::String(s) => s.trim().into(),
            _ => return Err(format!("{name} is invalid.")),
        };
        let (whole, frac) = raw.split_once('.').unwrap_or((&raw, ""));
        if whole.is_empty()
            || !whole.bytes().all(|d| d.is_ascii_digit())
            || !frac.bytes().all(|d| d.is_ascii_digit())
            || frac.len() > 8
            || (raw.contains('.') && frac.is_empty())
        {
            return Err(format!("{name} is invalid."));
        }
        let mut digits = vec![0; 8 - frac.len()];
        digits.extend(
            frac.bytes()
                .rev()
                .chain(whole.bytes().rev())
                .map(|d| d - b'0'),
        );
        while digits.last() == Some(&0) {
            digits.pop();
        }
        if digits.is_empty() {
            return Err(format!("{name} must be greater than zero."));
        }
        Ok(Self(digits))
    }
    pub fn add_times(&mut self, other: &Self, multiplier: u32) {
        let mut carry = 0;
        self.0.resize(self.0.len().max(other.0.len()), 0);
        for (idx, v) in self.0.iter_mut().enumerate() {
            let n = u32::from(*v)
                + u32::from(other.0.get(idx).copied().unwrap_or(0)) * multiplier
                + carry;
            *v = (n % 10) as u8;
            carry = n / 10;
        }
        while carry > 0 {
            self.0.push((carry % 10) as u8);
            carry /= 10;
        }
    }
    pub fn canonical(&self) -> String {
        let mut digits = self.0.clone();
        digits.resize(digits.len().max(9), 0);
        let mut s = digits
            .iter()
            .rev()
            .map(|d| (d + b'0') as char)
            .collect::<String>();
        s.insert(s.len() - 8, '.');
        s.trim_end_matches('0').trim_end_matches('.').into()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn exact_prices() {
        let decimal = |s| Decimal::parse(&json!(s), "price").unwrap();
        assert_eq!(decimal("0000000000001.23000000").canonical(), "1.23");
        let mut a = decimal("99999999999999999999.99999999");
        a.add_times(&decimal("0.00000001"), 1);
        assert_eq!(a.canonical(), "100000000000000000000");
        let mut b = Decimal::default();
        b.add_times(&decimal("12345678901234567890.12345678"), 99);
        assert_eq!(b.canonical(), "1222222211222222221122.22222122");
    }
}
