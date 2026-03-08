use nsm_api::api::{Request, Response};
use nsm_api::driver;
use serde_bytes::ByteBuf;
use std::fmt::Write as _;
use std::io::{self, BufRead, Write};

trait NsmBackend {
    fn get_attestation(&self, public_key: &[u8]) -> Result<Vec<u8>, &'static str>;
    fn get_random(&self) -> Result<Vec<u8>, &'static str>;
}

struct NitroBackend {
    fd: i32,
}

impl NitroBackend {
    fn open() -> Result<Self, &'static str> {
        let fd = driver::nsm_init();
        if fd < 0 {
            return Err("nsm_init_failed");
        }
        Ok(Self { fd })
    }
}

impl Drop for NitroBackend {
    fn drop(&mut self) {
        driver::nsm_exit(self.fd);
    }
}

impl NsmBackend for NitroBackend {
    fn get_attestation(&self, public_key: &[u8]) -> Result<Vec<u8>, &'static str> {
        if public_key.len() != 32 {
            return Err("invalid_public_key_length");
        }

        let request = Request::Attestation {
            user_data: None,
            nonce: None,
            public_key: Some(ByteBuf::from(public_key.to_vec())),
        };
        let response = driver::nsm_process_request(self.fd, request);

        match response {
            Response::Attestation { document } => Ok(document),
            Response::Error(_) => Err("nsm_error"),
            _ => Err("unexpected_response"),
        }
    }

    fn get_random(&self) -> Result<Vec<u8>, &'static str> {
        let response = driver::nsm_process_request(self.fd, Request::GetRandom);

        match response {
            Response::GetRandom { random } => Ok(random),
            Response::Error(_) => Err("nsm_error"),
            _ => Err("unexpected_response"),
        }
    }
}

fn main() -> io::Result<()> {
    let backend = NitroBackend::open().map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();

    for line in stdin.lock().lines() {
        let line = line?;
        let response = handle_line(&backend, &line);
        writeln!(stdout, "{response}")?;
        stdout.flush()?;
    }

    Ok(())
}

fn handle_line<B: NsmBackend>(backend: &B, line: &str) -> String {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return "0 ERR empty_request".to_string();
    }

    let mut parts = trimmed.splitn(3, ' ');
    let id = match parts.next() {
        Some(id) if !id.is_empty() => id,
        _ => return "0 ERR invalid_request".to_string(),
    };

    match parts.next() {
        Some("ATT") => {
            let hex = match parts.next() {
                Some(hex) if !hex.is_empty() => hex,
                _ => return format!("{id} ERR missing_public_key"),
            };
            match decode_hex(hex) {
                Some(public_key) => match backend.get_attestation(&public_key) {
                    Ok(document) => format!("{id} OK {}", encode_hex(&document)),
                    Err(err) => format!("{id} ERR {err}"),
                },
                None => format!("{id} ERR invalid_hex"),
            }
        }
        Some("RND") => match backend.get_random() {
            Ok(random) => format!("{id} OK {}", encode_hex(&random)),
            Err(err) => format!("{id} ERR {err}"),
        },
        Some(_) => format!("{id} ERR unknown_method"),
        None => format!("{id} ERR invalid_request"),
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn decode_hex(input: &str) -> Option<Vec<u8>> {
    if input.len() % 2 != 0 {
        return None;
    }

    let mut out = Vec::with_capacity(input.len() / 2);
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let hi = decode_nibble(bytes[i])?;
        let lo = decode_nibble(bytes[i + 1])?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Some(out)
}

fn decode_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeBackend;

    impl NsmBackend for FakeBackend {
        fn get_attestation(&self, public_key: &[u8]) -> Result<Vec<u8>, &'static str> {
            Ok(public_key.to_vec())
        }

        fn get_random(&self) -> Result<Vec<u8>, &'static str> {
            Ok(vec![0xde, 0xad, 0xbe, 0xef])
        }
    }

    #[test]
    fn decode_hex_rejects_odd_length() {
        assert!(decode_hex("0").is_none());
    }

    #[test]
    fn decode_hex_rejects_invalid_characters() {
        assert!(decode_hex("zz").is_none());
    }

    #[test]
    fn encode_hex_round_trips() {
        let bytes = vec![0xde, 0xad, 0xbe, 0xef];
        assert_eq!(decode_hex(&encode_hex(&bytes)), Some(bytes));
    }

    #[test]
    fn handle_attestation_request() {
        let public_key = "11".repeat(32);
        let response = handle_line(&FakeBackend, &format!("1 ATT {public_key}"));
        assert_eq!(response, format!("1 OK {public_key}"));
    }

    #[test]
    fn handle_random_request() {
        let response = handle_line(&FakeBackend, "2 RND");
        assert_eq!(response, "2 OK deadbeef");
    }

    #[test]
    fn handle_unknown_method() {
        let response = handle_line(&FakeBackend, "3 NOPE");
        assert_eq!(response, "3 ERR unknown_method");
    }

    #[test]
    fn handle_invalid_hex() {
        let response = handle_line(&FakeBackend, "4 ATT zz");
        assert_eq!(response, "4 ERR invalid_hex");
    }

    #[test]
    fn handle_empty_line() {
        let response = handle_line(&FakeBackend, "");
        assert_eq!(response, "0 ERR empty_request");
    }

    #[test]
    fn handle_whitespace_only() {
        let response = handle_line(&FakeBackend, "   ");
        assert_eq!(response, "0 ERR empty_request");
    }

    #[test]
    fn handle_id_only() {
        let response = handle_line(&FakeBackend, "5");
        assert_eq!(response, "5 ERR invalid_request");
    }

    #[test]
    fn handle_att_missing_payload() {
        let response = handle_line(&FakeBackend, "6 ATT");
        assert_eq!(response, "6 ERR missing_public_key");
    }

    #[test]
    fn handle_att_empty_payload() {
        let response = handle_line(&FakeBackend, "7 ATT ");
        assert_eq!(response, "7 ERR missing_public_key");
    }

    #[test]
    fn handle_att_odd_length_hex() {
        let response = handle_line(&FakeBackend, "8 ATT abc");
        assert_eq!(response, "8 ERR invalid_hex");
    }

    struct StrictFakeBackend;

    impl NsmBackend for StrictFakeBackend {
        fn get_attestation(&self, public_key: &[u8]) -> Result<Vec<u8>, &'static str> {
            if public_key.len() != 32 {
                return Err("invalid_public_key_length");
            }
            Ok(public_key.to_vec())
        }

        fn get_random(&self) -> Result<Vec<u8>, &'static str> {
            Ok(vec![0xca, 0xfe])
        }
    }

    #[test]
    fn handle_att_wrong_key_length_short() {
        // 16 bytes (too short)
        let short_key = "aa".repeat(16);
        let response = handle_line(&StrictFakeBackend, &format!("9 ATT {short_key}"));
        assert_eq!(response, "9 ERR invalid_public_key_length");
    }

    #[test]
    fn handle_att_wrong_key_length_long() {
        // 64 bytes (too long)
        let long_key = "bb".repeat(64);
        let response = handle_line(&StrictFakeBackend, &format!("10 ATT {long_key}"));
        assert_eq!(response, "10 ERR invalid_public_key_length");
    }

    #[test]
    fn handle_att_correct_key_length() {
        let key = "cc".repeat(32);
        let response = handle_line(&StrictFakeBackend, &format!("11 ATT {key}"));
        assert_eq!(response, format!("11 OK {key}"));
    }
}
