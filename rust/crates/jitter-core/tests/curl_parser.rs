use jitter_core::curl_parser::{normalize_structured, parse_curl_command, CurlParseError, StructuredRequestInput};
use serde_json::{json, Value as Json};

fn error_of(expression: &str) -> String {
    parse_curl_command(expression)
        .err()
        .map(|error| error.0)
        .unwrap_or_else(|| "expected a CurlParseError".to_string())
}

fn headers(spec: &Json) -> serde_json::Map<String, Json> {
    spec.get("headers").unwrap().as_object().expect("object").clone()
}

fn header(spec: &Json, name: &str) -> Option<String> {
    headers(spec).get(name).and_then(|value| value.as_str()).map(str::to_string)
}

fn body(spec: &Json) -> Option<String> {
    spec.get("body").and_then(|value| value.as_str()).map(str::to_string)
}

fn method(spec: &Json) -> String {
    spec.get("method").and_then(|value| value.as_str()).unwrap_or("").to_string()
}

fn url(spec: &Json) -> String {
    spec.get("url").and_then(|value| value.as_str()).unwrap_or("").to_string()
}

fn options(spec: &Json) -> Json {
    spec.get("options").cloned().unwrap_or(Json::Null)
}

#[test]
fn parses_a_simple_get_url() {
    let spec = json!(parse_curl_command("curl https://example.com/api?a=1").expect("parse"));
    assert_eq!(url(&spec), "https://example.com/api?a=1");
    assert_eq!(method(&spec), "GET");
    assert!(headers(&spec).is_empty());
    assert_eq!(body(&spec), None);
}

#[test]
fn parses_method_headers_and_quoted_data() {
    let spec = json!(parse_curl_command(
        "curl -X POST 'https://example.com/hook' -H 'Content-Type: application/json' -H \"Authorization: Bearer abc\" -d '{\"a\": 1}'"
    ).expect("parse"));
    assert_eq!(method(&spec), "POST");
    assert_eq!(header(&spec, "Content-Type"), Some("application/json".to_string()));
    assert_eq!(header(&spec, "Authorization"), Some("Bearer abc".to_string()));
    assert_eq!(body(&spec), Some("{\"a\": 1}".to_string()));
}

#[test]
fn handles_backslash_line_continuations() {
    let input = "curl -X POST \\\n  https://example.com/x \\\n  -H 'X-Test: yes' \\\n  -d 'a=1&b=2'";
    let spec = json!(parse_curl_command(input).expect("parse"));
    assert_eq!(url(&spec), "https://example.com/x");
    assert_eq!(header(&spec, "X-Test"), Some("yes".to_string()));
    assert_eq!(body(&spec), Some("a=1&b=2".to_string()));
}

#[test]
fn infers_post_and_a_form_content_type_from_data() {
    let spec = json!(parse_curl_command("curl https://example.com/form -d 'a=1'").expect("parse"));
    assert_eq!(method(&spec), "POST");
    let content_type = header(&spec, "content-type")
        .or_else(|| header(&spec, "Content-Type"))
        .expect("content type");
    assert_eq!(content_type, "application/x-www-form-urlencoded");
}

#[test]
fn joins_multiple_data_options_with_ampersand() {
    let spec = json!(parse_curl_command("curl https://example.com -d a=1 -d b=2").expect("parse"));
    assert_eq!(body(&spec), Some("a=1&b=2".to_string()));
}

#[test]
fn supports_attached_short_option_values() {
    let spec = json!(parse_curl_command("curl -XPUT -H'X-A: 1' -d'a=1' https://example.com").expect("parse"));
    assert_eq!(method(&spec), "PUT");
    assert_eq!(header(&spec, "X-A"), Some("1".to_string()));
    assert_eq!(body(&spec), Some("a=1".to_string()));
}

#[test]
fn supports_long_options_with_equals() {
    let spec = json!(parse_curl_command(
        "curl --request=PATCH --header='X-A: 1' --data-raw='{\"x\":1}' https://example.com"
    ).expect("parse"));
    assert_eq!(method(&spec), "PATCH");
    assert_eq!(header(&spec, "X-A"), Some("1".to_string()));
    assert_eq!(body(&spec), Some("{\"x\":1}".to_string()));
}

#[test]
fn supports_url_and_terminator() {
    let spec = json!(parse_curl_command("curl --url https://example.com/a").expect("parse"));
    assert_eq!(url(&spec), "https://example.com/a");
    let spec = json!(parse_curl_command("curl -- https://example.com/b").expect("parse"));
    assert_eq!(url(&spec), "https://example.com/b");
}

#[test]
fn keeps_an_explicitly_empty_data_body() {
    let spec = json!(parse_curl_command("curl -X POST https://example.com -d ''").expect("parse"));
    assert_eq!(body(&spec), Some(String::new()));
}

#[test]
fn allows_a_literal_at_body_with_data_raw() {
    let spec = json!(parse_curl_command("curl --data-raw '@literal' https://example.com").expect("parse"));
    assert_eq!(body(&spec), Some("@literal".to_string()));
}

#[test]
fn maps_cookie_flags_to_the_cookie_header() {
    let short = json!(parse_curl_command("curl -b 'session=abc; theme=dark' https://example.com").expect("parse"));
    assert_eq!(header(&short, "Cookie"), Some("session=abc; theme=dark".to_string()));

    let long = json!(parse_curl_command("curl --cookie 'a=1' https://example.com").expect("parse"));
    assert_eq!(header(&long, "Cookie"), Some("a=1".to_string()));
}

#[test]
fn combines_multiple_cookie_values_and_an_explicit_header() {
    let spec = json!(parse_curl_command(
        "curl -H 'Cookie: first=1' -b 'a=1' -b 'b=2' https://example.com"
    ).expect("parse"));
    assert_eq!(header(&spec, "Cookie"), Some("first=1; a=1; b=2".to_string()));
}

#[test]
fn supports_attached_cookie_values() {
    let spec = json!(parse_curl_command("curl -bsession=abc https://example.com").expect("parse"));
    assert_eq!(header(&spec, "Cookie"), Some("session=abc".to_string()));
}

#[test]
fn ignores_an_empty_cookie_value() {
    let spec = json!(parse_curl_command("curl -b '' https://example.com").expect("parse"));
    assert_eq!(header(&spec, "Cookie"), None);
}

#[test]
fn rejects_a_cookie_file_path_instead_of_reading_it() {
    assert!(error_of("curl -b cookies.txt https://example.com").contains("cookie"));
}

#[test]
fn parses_a_browser_style_copy_as_curl_command() {
    let spec = json!(parse_curl_command(
        "curl 'https://example.com/api' -H 'User-Agent: Mozilla/5.0' -H 'Accept: application/json' --compressed -b 'session=abc; theme=dark'"
    ).expect("parse"));
    assert_eq!(url(&spec), "https://example.com/api");
    assert_eq!(header(&spec, "User-Agent"), Some("Mozilla/5.0".to_string()));
    assert_eq!(header(&spec, "Cookie"), Some("session=abc; theme=dark".to_string()));
}

#[test]
fn accepts_harmless_output_only_flags() {
    let spec = json!(parse_curl_command("curl -sS -i -v --compressed -L https://example.com").expect("parse"));
    assert_eq!(url(&spec), "https://example.com");
}

#[test]
fn keeps_colons_inside_header_values() {
    let spec = json!(parse_curl_command("curl -H 'X-Time: 12:30:00' https://example.com").expect("parse"));
    assert_eq!(header(&spec, "X-Time"), Some("12:30:00".to_string()));
}

#[test]
fn rejects_unsupported_flags_with_the_flag_name() {
    assert!(error_of("curl -F 'a=b' https://example.com").contains("-F"));
    assert!(error_of("curl --resolve example.com:443:127.0.0.1 https://example.com").contains("--resolve"));
}

fn expected_basic(credentials: &str) -> String {
    // base64("user:pass")
    use base64::Engine as _;
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(credentials))
}

#[test]
fn maps_user_to_basic_authorization() {
    let spec = json!(parse_curl_command("curl -u user:pass https://example.com").expect("parse"));
    assert_eq!(header(&spec, "Authorization"), Some(expected_basic("user:pass")));
}

#[test]
fn maps_common_request_shaping_flags_and_options() {
    let spec = json!(parse_curl_command(
        "curl -X POST -A 'Agent/1.0' -e 'https://ref.example' -u user:pass --oauth2-bearer token -r 0-99 --max-time 2.5 --connect-timeout 1 --insecure -x http://proxy.example:8080 -U proxy:pass https://example.com"
    ).expect("parse"));
    assert_eq!(method(&spec), "POST");
    assert_eq!(header(&spec, "User-Agent"), Some("Agent/1.0".to_string()));
    assert_eq!(header(&spec, "Referer"), Some("https://ref.example".to_string()));
    assert_eq!(header(&spec, "Authorization"), Some("Bearer token".to_string()));
    assert_eq!(header(&spec, "Range"), Some("0-99".to_string()));
    assert_eq!(header(&spec, "Proxy-Authorization"), None);
    assert_eq!(
        options(&spec),
        json!({
            "insecure": true,
            "timeoutMs": 2500,
            "proxy": "http://proxy.example:8080/",
            "proxyAuthorization": expected_basic("proxy:pass"),
        })
    );
}

#[test]
fn requires_proxy_when_proxy_user_is_used_and_strips_proxy_url_credentials() {
    assert!(error_of("curl -U proxy:pass https://example.com").contains("-x"));

    let spec = json!(parse_curl_command(
        "curl -x http://user:pass@proxy.example:8080 -U override:pass https://example.com"
    ).expect("parse"));
    let options = options(&spec);
    assert_eq!(
        options.get("proxy").and_then(|v| v.as_str()),
        Some("http://proxy.example:8080/")
    );
    assert_eq!(
        options.get("proxyAuthorization").and_then(|v| v.as_str()),
        Some(expected_basic("override:pass").as_str())
    );
    assert_eq!(header(&spec, "Proxy-Authorization"), None);
}

#[test]
fn explicit_headers_win_over_convenience_flags() {
    let first = json!(parse_curl_command(
        "curl -H 'Authorization: Custom' -u user:pass -H 'User-Agent: Explicit' -A Agent https://example.com"
    ).expect("parse"));
    assert_eq!(header(&first, "Authorization"), Some("Custom".to_string()));
    assert_eq!(header(&first, "User-Agent"), Some("Explicit".to_string()));

    let second = json!(parse_curl_command(
        "curl -u user:pass -H 'Authorization: Custom' -A Agent -H 'User-Agent: Explicit' https://example.com"
    ).expect("parse"));
    assert_eq!(header(&second, "Authorization"), Some("Custom".to_string()));
    assert_eq!(header(&second, "User-Agent"), Some("Explicit".to_string()));
}

#[test]
fn supports_curls_empty_header_idiom() {
    let spec = json!(parse_curl_command("curl -H 'X-Empty;' https://example.com").expect("parse"));
    assert_eq!(header(&spec, "X-Empty"), Some(String::new()));
}

#[test]
fn maps_json_to_a_json_post() {
    let spec = json!(parse_curl_command("curl --json '{\"a\":1}' https://example.com").expect("parse"));
    assert_eq!(method(&spec), "POST");
    assert_eq!(body(&spec), Some("{\"a\":1}".to_string()));
    assert_eq!(header(&spec, "Content-Type"), Some("application/json".to_string()));
    assert_eq!(header(&spec, "Accept"), Some("application/json".to_string()));
}

#[test]
fn concatenates_multiple_json_and_data_parts_in_order() {
    let multiple = json!(parse_curl_command(
        "curl --json '{\"a\":1}' --json '{\"b\":2}' https://example.com"
    ).expect("parse"));
    assert_eq!(body(&multiple), Some("{\"a\":1}&{\"b\":2}".to_string()));

    let mixed = json!(parse_curl_command(
        "curl --json '{\"a\":1}' -d b=2 https://example.com"
    ).expect("parse"));
    assert_eq!(body(&mixed), Some("{\"a\":1}&b=2".to_string()));
}

#[test]
fn rejects_get_combined_with_json() {
    assert!(error_of("curl -G --json '{\"a\":1}' https://example.com").contains("--json"));
}

#[test]
fn get_moves_data_into_the_query_and_clears_the_body() {
    let spec = json!(parse_curl_command(
        "curl -G -d a=1 -d b=2 https://example.com/path?x=1"
    ).expect("parse"));
    assert_eq!(method(&spec), "GET");
    assert_eq!(body(&spec), None);
    assert_eq!(url(&spec), "https://example.com/path?x=1&a=1&b=2");
}

#[test]
fn maps_data_urlencode_and_url_query() {
    let data = json!(parse_curl_command(
        "curl --data-urlencode 'q=hello world' https://example.com"
    ).expect("parse"));
    assert_eq!(body(&data), Some("q=hello%20world".to_string()));

    let query = json!(parse_curl_command(
        "curl --url-query 'a=1' --url-query '+b=hello world' https://example.com/path"
    ).expect("parse"));
    assert_eq!(url(&query), "https://example.com/path?a=1&b=hello%20world");
    assert_eq!(method(&query), "GET");
}

#[test]
fn maps_head_and_redirect_flags_to_options() {
    let head = json!(parse_curl_command("curl -I https://example.com").expect("parse"));
    assert_eq!(method(&head), "HEAD");
    assert_eq!(
        options(&json!(parse_curl_command("curl --no-location https://example.com").expect("parse"))),
        json!({ "redirect": "manual" })
    );
    assert_eq!(
        options(&json!(parse_curl_command("curl -L https://example.com").expect("parse"))),
        json!({ "redirect": "follow" })
    );
}

#[test]
fn maps_connect_timeout_as_a_timeout_fallback() {
    let spec = json!(parse_curl_command("curl --connect-timeout 3 https://example.com").expect("parse"));
    assert_eq!(
        options(&spec).get("timeoutMs").and_then(|v| v.as_i64()),
        Some(3000)
    );
}

#[test]
fn rejects_non_decimal_or_overlong_timeouts() {
    assert!(error_of("curl --max-time 1e3 https://example.com").contains("秒数"));
    assert!(error_of("curl --max-time 0x10 https://example.com").contains("秒数"));
    assert!(error_of("curl --max-time 86401 https://example.com").contains("24"));
}

#[test]
fn accepts_a_bare_host_port_proxy() {
    let spec = json!(parse_curl_command("curl -x 127.0.0.1:8080 https://example.com").expect("parse"));
    assert_eq!(
        options(&spec).get("proxy").and_then(|v| v.as_str()),
        Some("http://127.0.0.1:8080/")
    );
}

#[test]
fn accepts_common_output_and_behavior_flags_as_noops() {
    let spec = json!(parse_curl_command(
        "curl -sS -o out.txt -D headers.txt -w '%{http_code}' --retry 3 --max-redirs 5 --http2 --compressed --fail --globoff https://example.com"
    ).expect("parse"));
    assert_eq!(url(&spec), "https://example.com");
    assert_eq!(body(&spec), None);
}

#[test]
fn rejects_unsupported_proxy_protocols() {
    assert!(error_of("curl -x socks5://127.0.0.1:1080 https://example.com").contains("http/https"));
}

#[test]
fn rejects_a_missing_url() {
    assert!(error_of("curl -X POST -d a=1").contains("URL"));
}

#[test]
fn rejects_at_file_bodies_instead_of_reading_files() {
    assert!(error_of("curl https://example.com -d @body.json").contains("@"));
}

#[test]
fn rejects_get_with_a_body() {
    assert!(error_of("curl -X GET https://example.com -d a=1").contains("GET"));
}

#[test]
fn rejects_non_http_protocols() {
    assert!(error_of("curl file:///etc/passwd").contains("http"));
}

#[test]
fn rejects_unterminated_quotes() {
    assert!(error_of("curl 'https://example.com").contains("引号"));
}

fn structured_error_of(input: StructuredRequestInput) -> String {
    normalize_structured(&input)
        .err()
        .map(|error| error.0)
        .unwrap_or_else(|| "expected a CurlParseError".to_string())
}

#[test]
fn structured_defaults_to_get() {
    let spec = json!(normalize_structured(&StructuredRequestInput {
        url: "https://example.com".to_string(),
        ..Default::default()
    }).expect("parse"));
    assert_eq!(url(&spec), "https://example.com");
    assert_eq!(method(&spec), "GET");
    assert!(headers(&spec).is_empty());
    assert_eq!(body(&spec), None);
}

#[test]
fn structured_parses_header_lines_and_a_body() {
    let spec = json!(normalize_structured(&StructuredRequestInput {
        url: "https://example.com".to_string(),
        method: Some("post".to_string()),
        header_lines: Some("Content-Type: application/json\n\nX-A: 1".to_string()),
        body: Some("{\"ok\":true}".to_string()),
        headers: None,
    }).expect("parse"));
    assert_eq!(method(&spec), "POST");
    assert_eq!(header(&spec, "Content-Type"), Some("application/json".to_string()));
    assert_eq!(header(&spec, "X-A"), Some("1".to_string()));
    assert_eq!(body(&spec), Some("{\"ok\":true}".to_string()));
}

#[test]
fn structured_accepts_a_header_object() {
    let spec = json!(normalize_structured(&StructuredRequestInput {
        url: "https://example.com".to_string(),
        method: None,
        header_lines: None,
        headers: Some(json!({ "X-A": "1" }).as_object().unwrap().clone()),
        body: None,
    }).expect("parse"));
    assert_eq!(header(&spec, "X-A"), Some("1".to_string()));
}

#[test]
fn structured_rejects_malformed_header_lines() {
    let message = structured_error_of(StructuredRequestInput {
        url: "https://example.com".to_string(),
        method: None,
        header_lines: Some("no-colon".to_string()),
        headers: None,
        body: None,
    });
    assert!(message.contains("Header"), "{message}");
}

#[test]
fn structured_rejects_get_with_a_body() {
    let message = structured_error_of(StructuredRequestInput {
        url: "https://example.com".to_string(),
        method: Some("GET".to_string()),
        header_lines: None,
        headers: None,
        body: Some("x".to_string()),
    });
    assert!(message.contains("GET"), "{message}");
}

#[test]
fn tokenizer_rejects_unbalanced_quotes() {
    assert!(jitter_core::curl_parser::tokenize_curl("curl 'abc").is_err());
}
