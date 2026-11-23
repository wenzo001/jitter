use jitter_core::condition::{evaluate_condition, validate_condition, ConditionContext};
use serde_json::json;

fn context(json_value: serde_json::Value) -> ConditionContext {
    let body = serde_json::to_string(&json_value).ok();
    ConditionContext {
        json: Some(json_value),
        status: Some(200),
        body,
    }
}

fn eval_json(expression: &str, json_value: serde_json::Value) -> bool {
    evaluate_condition(expression, &context(json_value))
}

fn success_body() -> serde_json::Value {
    json!({
        "ok": true,
        "data": {
            "result": {
                "checktime": 1794828938930i64,
                "description": "19:35在高新人才大厦签退成功",
                "nexttime": 1794882420999i64,
                "remindtype": 0,
                "checkwarn": null
            },
            "applied": true
        },
        "error": null,
        "status": { "checkIn": 1, "checkOut": 1 }
    })
}

fn failure_body() -> serde_json::Value {
    json!({
        "ok": false,
        "data": {
            "needsMemo": false,
            "error": { "kind": "business", "code": 900, "explanation": "不在规定时间，不允许打卡" }
        }
    })
}

#[test]
fn accepts_valid_expressions_and_empty_strings() {
    assert_eq!(validate_condition(""), None);
    assert_eq!(validate_condition("   "), None);
    assert_eq!(validate_condition("data.result.remindtype=0"), None);
    assert_eq!(validate_condition("data.error==null && $status=200"), None);
    assert_eq!(validate_condition("data?.result?.[0] != undefined ? 1 : 0"), None);
}

#[test]
fn reports_syntax_errors_with_a_chinese_message() {
    for expression in ["data.", "data.result ==", "(data.ok", "data.ok ? 1"] {
        let message = validate_condition(expression).unwrap_or_default();
        assert!(message.contains("语法错误"), "{expression} -> {message}");
    }
    let message = validate_condition("data.ok @ 1").unwrap_or_default();
    assert!(message.contains("不支持的字符"), "{message}");
}

#[test]
fn rejects_oversized_expressions() {
    let expression = format!("data.result = {}", "9".repeat(1_100));
    let message = validate_condition(&expression).unwrap_or_default();
    assert!(message.contains("不能超过"), "{message}");
}

#[test]
fn keeps_question_dot_followed_by_digit_as_a_ternary() {
    assert_eq!(validate_condition("true?.5:0"), None);
    let ctx = ConditionContext {
        json: None,
        status: Some(200),
        body: Some(String::new()),
    };
    assert!(evaluate_condition("true?.5:0", &ctx));
    assert!(!evaluate_condition("false?.5:0", &ctx));
}

#[test]
fn resolves_nested_paths() {
    assert!(eval_json("data.result.remindtype=0", success_body()));
    assert!(eval_json("data.result.checkwarn=null", success_body()));
    assert!(eval_json("ok=true", success_body()));
    assert!(eval_json("status.checkIn=1", success_body()));
}

#[test]
fn missing_intermediate_path_does_not_throw() {
    assert!(!eval_json("data.result.missing=0", success_body()));
    assert!(!eval_json("data.result.missing!=0", success_body()));
    assert!(!eval_json("data.nope.deep.value=1", success_body()));
    assert!(!eval_json("data.result.remindtype.deep=0", success_body()));
}

#[test]
fn optional_chaining_and_computed_access_are_safe() {
    assert!(eval_json("data?.result?.remindtype=0", success_body()));
    assert!(eval_json("data[\"result\"][\"remindtype\"]=0", success_body()));
    assert!(eval_json("data.result['checktime']=1794828938930", success_body()));
    assert!(!eval_json("data['missing']?.deep=0", success_body()));
}

#[test]
fn array_index_access_works() {
    let body = json!({ "list": [{ "code": 0 }, { "code": 900 }] });
    assert!(eval_json("list[0].code=0", body.clone()));
    assert!(eval_json("list[1].code=900", body.clone()));
    assert!(!eval_json("list[5].code=0", body));
}

#[test]
fn string_index_access_works() {
    let ctx = ConditionContext {
        json: None,
        status: Some(200),
        body: Some("abc".to_string()),
    };
    assert!(evaluate_condition("$body[0]='a'", &ctx));
    assert!(!evaluate_condition("$body[3]='a'", &ctx));
}

#[test]
fn prototype_keys_are_blocked() {
    assert!(!eval_json("data.constructor=1", success_body()));
    assert!(!eval_json("data.__proto__=1", success_body()));
}

#[test]
fn non_json_body_makes_paths_missing() {
    let ctx = ConditionContext {
        json: None,
        status: Some(200),
        body: Some("plain text".to_string()),
    };
    assert!(!evaluate_condition("data.result.remindtype=0", &ctx));
    assert!(evaluate_condition("$status=200", &ctx));
}

#[test]
fn equals_is_loose_equality() {
    let zero = json!({ "value": 0 });
    let zero_string = json!({ "value": "0" });
    assert!(eval_json("value=0", zero.clone()));
    assert!(eval_json("value=0", zero_string.clone()));
    assert!(eval_json("value==0", zero_string.clone()));
    assert!(!eval_json("value===0", zero_string));
    assert!(eval_json("value===0", zero));
}

#[test]
fn distinguishes_undefined_and_null() {
    let body = success_body();
    assert!(!eval_json("error!=undefined", body.clone()));
    assert!(!eval_json("error!=null", body.clone()));
    assert!(eval_json("error!==undefined", body.clone()));
    assert!(!eval_json("error!==null", body.clone()));
    assert!(!eval_json("data.error.code!==null", body.clone()));
    assert!(eval_json("error===null", body.clone()));
    assert!(!eval_json("data.result.missing!=undefined", body.clone()));
    assert!(!eval_json("data.result.missing==undefined", body));
}

#[test]
fn relational_operators() {
    assert!(eval_json("data.result.checktime>0", success_body()));
    assert!(eval_json(
        "data.result.nexttime>data.result.checktime",
        success_body()
    ));
    assert!(eval_json("data.result.remindtype<1", success_body()));
    assert!(eval_json(
        "data.result.description>\"19\"",
        success_body()
    ));
}

#[test]
fn arithmetic() {
    assert!(eval_json("data.result.remindtype+1=1", success_body()));
    assert!(eval_json(
        "data.result.checktime-data.result.checktime=0",
        success_body()
    ));
    assert!(eval_json("2*3=6", success_body()));
    assert!(eval_json("7%3=1", success_body()));
}

#[test]
fn plus_concatenates_when_either_side_is_a_string() {
    assert!(eval_json("prefix+id='AB12'", json!({ "prefix": "AB", "id": 12 })));
    assert!(eval_json("id+prefix='12AB'", json!({ "prefix": "AB", "id": 12 })));
    assert!(eval_json("'5'+3='53'", json!({})));
    assert!(eval_json("2+3=5", json!({})));
}

#[test]
fn logical_operators_short_circuit() {
    assert!(eval_json(
        "ok=true && data.result.remindtype=0",
        success_body()
    ));
    assert!(eval_json(
        "ok=false || data.result.remindtype=0",
        success_body()
    ));
    assert!(!eval_json(
        "ok=false && data.result.remindtype=0",
        success_body()
    ));
    assert!(eval_json("!error", success_body()));
    assert!(!eval_json("!!error", success_body()));
    assert!(!eval_json("!data.error", success_body()));
}

#[test]
fn ternary_expressions() {
    assert!(eval_json(
        "data.result.remindtype=0 ? true : false",
        success_body()
    ));
    assert!(!eval_json(
        "data.result.remindtype=1 ? true : false",
        success_body()
    ));
    assert!(eval_json(
        "ok=true ? data.result.remindtype=0 : false",
        success_body()
    ));
}

#[test]
fn meta_variables() {
    assert!(eval_json("$status=200", success_body()));
    assert!(eval_json("$status>=200 && $status<300", success_body()));
    assert!(!eval_json("$status=500", success_body()));
    let ctx = ConditionContext {
        json: None,
        status: Some(200),
        body: Some("abcdef".to_string()),
    };
    assert!(!evaluate_condition("$body.includes(\"x\")", &ctx));
}

#[test]
fn literals() {
    assert!(eval_json("true", success_body()));
    assert!(!eval_json("false", success_body()));
    assert!(!eval_json("null", success_body()));
    assert!(!eval_json("undefined", success_body()));
}

#[test]
fn missing_values_propagate() {
    assert!(!eval_json("data.missing!=0", success_body()));
    assert!(!eval_json("!(data.missing=0)", success_body()));
    assert!(!eval_json("data.missing=0 ? true : false", success_body()));
}

#[test]
fn never_throws_on_malformed_runtime_input() {
    let ctx = context(success_body());
    assert!(!evaluate_condition("data.", &ctx));
    assert!(!evaluate_condition("", &ctx));
    assert!(!evaluate_condition("1/0=1", &ctx));
}

#[test]
fn tells_apart_checkin_success_and_business_failure() {
    assert!(eval_json("data.result.remindtype=0", success_body()));
    assert!(!eval_json("data.result.remindtype=0", failure_body()));
    assert!(eval_json("data.error.code=900", failure_body()));
    assert!(!eval_json("data.error.code=900", success_body()));
    assert!(eval_json(
        "ok=true && data.result.checkwarn=null",
        success_body()
    ));
    assert!(!eval_json(
        "ok=true && data.result.checkwarn=null",
        failure_body()
    ));
}
