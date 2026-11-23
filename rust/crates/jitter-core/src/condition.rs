//! 通知成立条件：一个受限的「类 JS 表达式」求值器。
//!
//! 与 TypeScript 版（`src/condition.ts`）行为一致：
//! - 不执行任意代码，只解析并解释执行允许的运算符。
//! - 所有属性访问都是安全取值：路径中途缺失时得到 `Value::Missing`，
//!   不会 panic；含 `Missing` 的比较一律不成立（包括 `!=`）。
//! - `=` 与 `==` 同义（宽松相等），所以字符串 `"0"` 与数字 `0` 都匹配 `=0`。

use serde_json::Value as Json;

const MAX_LENGTH: usize = 1_000;
const MAX_TOKENS: usize = 500;
const MAX_DEPTH: usize = 64;
const MAX_STEPS: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConditionError(pub String);

impl std::fmt::Display for ConditionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConditionError {}

fn err<T>(message: impl Into<String>) -> Result<T, ConditionError> {
    Err(ConditionError(message.into()))
}

/// 求值过程中的一个值。`Missing` 表示「取不到」。
#[derive(Debug, Clone)]
pub enum Value {
    Missing,
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    Str(String),
    Json(Json),
}

impl Value {
    fn is_missing(&self) -> bool {
        matches!(self, Value::Missing)
    }

    fn is_nullish(&self) -> bool {
        matches!(self, Value::Null | Value::Undefined)
    }

    /// JS 的真值规则：空数组与空对象也是真。
    fn truthy(&self) -> bool {
        match self {
            Value::Missing | Value::Undefined | Value::Null => false,
            Value::Bool(b) => *b,
            Value::Number(n) => *n != 0.0 && !n.is_nan(),
            Value::Str(s) => !s.is_empty(),
            Value::Json(value) => match value {
                Json::Null => false,
                Json::Bool(b) => *b,
                Json::Number(n) => n.as_f64().map(|v| v != 0.0).unwrap_or(false),
                Json::String(s) => !s.is_empty(),
                _ => true,
            },
        }
    }

    /// JS 的 `String(value)`。
    fn to_js_string(&self) -> String {
        match self {
            Value::Missing => "undefined".to_string(),
            Value::Undefined => "undefined".to_string(),
            Value::Null => "null".to_string(),
            Value::Bool(b) => b.to_string(),
            Value::Number(n) => format_number(*n),
            Value::Str(s) => s.clone(),
            Value::Json(value) => json_to_js_string(value),
        }
    }

    /// JS 的 `Number(value)`。
    fn to_number(&self) -> f64 {
        match self {
            Value::Missing | Value::Undefined => f64::NAN,
            Value::Null => 0.0,
            Value::Bool(b) => {
                if *b {
                    1.0
                } else {
                    0.0
                }
            }
            Value::Number(n) => *n,
            Value::Str(s) => string_to_number(s),
            Value::Json(value) => match value {
                Json::Null => 0.0,
                Json::Bool(b) => {
                    if *b {
                        1.0
                    } else {
                        0.0
                    }
                }
                Json::Number(n) => n.as_f64().unwrap_or(f64::NAN),
                Json::String(s) => string_to_number(s),
                _ => f64::NAN,
            },
        }
    }
}

fn format_number(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if value == value.trunc() && value.abs() < 1e21 {
        return format!("{}", value as i64);
    }
    let mut text = format!("{}", value);
    if text.ends_with(".0") {
        text.truncate(text.len() - 2);
    }
    text
}

fn json_to_js_string(value: &Json) -> String {
    match value {
        Json::Null => "null".to_string(),
        Json::Bool(b) => b.to_string(),
        Json::Number(n) => match n.as_f64() {
            Some(v) => format_number(v),
            None => n.to_string(),
        },
        Json::String(s) => s.clone(),
        Json::Array(items) => items
            .iter()
            .map(|item| match item {
                Json::Null => String::new(),
                other => json_to_js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Json::Object(_) => "[object Object]".to_string(),
    }
}

/// JS 的 `Number(string)`：空串是 0，无法解析的返回 NaN。
fn string_to_number(text: &str) -> f64 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let (sign, rest) = match trimmed.strip_prefix('-') {
        Some(rest) => (-1.0, rest),
        None => (1.0, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    if let Some(hex) = rest.strip_prefix("0x").or_else(|| rest.strip_prefix("0X")) {
        return match u64::from_str_radix(hex, 16) {
            Ok(v) => sign * v as f64,
            Err(_) => f64::NAN,
        };
    }
    match rest.parse::<f64>() {
        Ok(v) => sign * v,
        Err(_) => f64::NAN,
    }
}

// ---------------------------------------------------------------------------
// 词法
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum TokenKind {
    Number(f64),
    Str(String),
    Ident(String),
    Op(String),
    Eof,
}

#[derive(Debug, Clone, PartialEq)]
struct Token {
    kind: TokenKind,
    pos: usize,
}

const OP_TWO: [&str; 7] = ["==", "!=", "<=", ">=", "&&", "||", "?."];
const OP_ONE: [&str; 17] = [
    "=", "!", "<", ">", "?", ":", ".", "[", "]", "(", ")", "+", "-", "*", "/", "%", ",",
];

fn is_ident_start(ch: char) -> bool {
    ch.is_alphabetic() || ch == '_' || ch == '$'
}

fn is_ident_part(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_' || ch == '$'
}

fn tokenize(source: &[char]) -> Result<Vec<Token>, ConditionError> {
    let mut tokens: Vec<Token> = Vec::new();
    let mut i = 0usize;
    while i < source.len() {
        let ch = source[i];
        if ch.is_whitespace() {
            i += 1;
            continue;
        }

        if ch == '"' || ch == '\'' {
            let start = i;
            let quote = ch;
            i += 1;
            let mut value = String::new();
            let mut closed = false;
            while i < source.len() {
                let current = source[i];
                i += 1;
                if current == quote {
                    closed = true;
                    break;
                }
                if current != '\\' {
                    value.push(current);
                    continue;
                }
                let escaped = match source.get(i) {
                    Some(value) => *value,
                    None => break,
                };
                i += 1;
                match escaped {
                    'n' => value.push('\n'),
                    'r' => value.push('\r'),
                    't' => value.push('\t'),
                    'u' => {
                        let hex: String = source[i.min(source.len())..(i + 4).min(source.len())]
                            .iter()
                            .collect();
                        if hex.len() == 4 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
                            if let Ok(code) = u32::from_str_radix(&hex, 16) {
                                if let Some(ch) = char::from_u32(code) {
                                    value.push(ch);
                                }
                            }
                            i += 4;
                        } else {
                            value.push('u');
                        }
                    }
                    other => value.push(other),
                }
            }
            if !closed {
                return err(format!("表达式语法错误：位置 {start} 的字符串未闭合"));
            }
            tokens.push(Token {
                kind: TokenKind::Str(value),
                pos: start,
            });
            continue;
        }

        if let Some((number, length)) = scan_number(source, i) {
            tokens.push(Token {
                kind: TokenKind::Number(number),
                pos: i,
            });
            i += length;
            continue;
        }

        if is_ident_start(ch) {
            let start = i;
            i += 1;
            while i < source.len() && is_ident_part(source[i]) {
                i += 1;
            }
            tokens.push(Token {
                kind: TokenKind::Ident(source[start..i].iter().collect()),
                pos: start,
            });
            continue;
        }

        let three: String = source[i..(i + 3).min(source.len())].iter().collect();
        if three == "===" || three == "!==" {
            tokens.push(Token {
                kind: TokenKind::Op(three),
                pos: i,
            });
            i += 3;
            continue;
        }

        let two: String = source[i..(i + 2).min(source.len())].iter().collect();
        // 与 ECMAScript 一致：`?.` 后紧跟数字时不作可选链，保留为三元 `?` + 小数。
        let optional_chain_followed_by_digit = two == "?."
            && source
                .get(i + 2)
                .map(|c| c.is_ascii_digit())
                .unwrap_or(false);
        if OP_TWO.contains(&two.as_str()) && !optional_chain_followed_by_digit {
            tokens.push(Token {
                kind: TokenKind::Op(two),
                pos: i,
            });
            i += 2;
            continue;
        }

        let one = ch.to_string();
        if OP_ONE.contains(&one.as_str()) {
            tokens.push(Token {
                kind: TokenKind::Op(one),
                pos: i,
            });
            i += 1;
            continue;
        }

        return err(format!(
            "表达式语法错误：位置 {i} 出现不支持的字符 {}",
            json_to_js_string(&Json::String(one))
        ));
    }
    tokens.push(Token {
        kind: TokenKind::Eof,
        pos: source.len(),
    });
    Ok(tokens)
}

/// 匹配 `(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?`，返回数值与长度。
fn scan_number(source: &[char], start: usize) -> Option<(f64, usize)> {
    let mut i = start;
    let mut digits = 0usize;
    while i < source.len() && source[i].is_ascii_digit() {
        i += 1;
        digits += 1;
    }
    if digits > 0 {
        if i < source.len() && source[i] == '.' {
            let mut j = i + 1;
            let mut fraction = 0usize;
            while j < source.len() && source[j].is_ascii_digit() {
                j += 1;
                fraction += 1;
            }
            // `\d+(\.\d*)?` 允许小数点后没有数字。
            i = j;
            let _ = fraction;
        }
    } else {
        if i < source.len() && source[i] == '.' {
            let mut j = i + 1;
            while j < source.len() && source[j].is_ascii_digit() {
                j += 1;
                digits += 1;
            }
            if digits == 0 {
                return None;
            }
            i = j;
        } else {
            return None;
        }
    }

    if i < source.len() && (source[i] == 'e' || source[i] == 'E') {
        let mut j = i + 1;
        if j < source.len() && (source[j] == '+' || source[j] == '-') {
            j += 1;
        }
        let mut exponent = 0usize;
        while j < source.len() && source[j].is_ascii_digit() {
            j += 1;
            exponent += 1;
        }
        if exponent > 0 {
            i = j;
        }
    }

    let text: String = source[start..i].iter().collect();
    match text.parse::<f64>() {
        Ok(value) => Some((value, i - start)),
        Err(_) => None,
    }
}

// ---------------------------------------------------------------------------
// 语法
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum Node {
    Literal(Value),
    Ident(String),
    Member {
        object: Box<Node>,
        property: Box<Property>,
    },
    Unary {
        operator: String,
        argument: Box<Node>,
    },
    Binary {
        operator: String,
        left: Box<Node>,
        right: Box<Node>,
    },
    Ternary {
        test: Box<Node>,
        consequent: Box<Node>,
        alternate: Box<Node>,
    },
}

#[derive(Debug, Clone)]
enum Property {
    Named(String),
    Computed(Box<Node>),
}

fn precedence(operator: &str) -> Option<u8> {
    Some(match operator {
        "||" => 1,
        "&&" => 2,
        "=" | "==" | "===" | "!=" | "!==" => 3,
        "<" | "<=" | ">" | ">=" => 4,
        "+" | "-" => 5,
        "*" | "/" | "%" => 6,
        _ => return None,
    })
}

struct Parser {
    tokens: Vec<Token>,
    index: usize,
    depth: usize,
}

impl Parser {
    fn peek(&self) -> &Token {
        &self.tokens[self.index]
    }

    fn take(&mut self) -> Token {
        let token = self.tokens[self.index].clone();
        self.index += 1;
        token
    }

    fn is_operator(&self, value: &str) -> bool {
        matches!(&self.peek().kind, TokenKind::Op(op) if op == value)
    }

    fn expect_operator(&mut self, value: &str) -> Result<(), ConditionError> {
        if !self.is_operator(value) {
            let token = self.peek().clone();
            return err(format!("表达式语法错误：位置 {} 应为 {value}", token.pos));
        }
        self.take();
        Ok(())
    }

    fn guard<T>(&mut self, callback: impl FnOnce(&mut Self) -> Result<T, ConditionError>) -> Result<T, ConditionError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return err("表达式嵌套过深");
        }
        let result = callback(self);
        self.depth -= 1;
        result
    }

    fn parse(&mut self) -> Result<Node, ConditionError> {
        let node = self.parse_ternary()?;
        let token = self.peek().clone();
        if !matches!(token.kind, TokenKind::Eof) {
            let extra = match &token.kind {
                TokenKind::Str(text) => text.clone(),
                TokenKind::Ident(text) => text.clone(),
                TokenKind::Number(number) => format_number(*number),
                TokenKind::Op(text) => text.clone(),
                TokenKind::Eof => String::new(),
            };
            return err(format!(
                "表达式语法错误：位置 {} 出现多余的内容 {}",
                token.pos,
                json_to_js_string(&Json::String(extra))
            ));
        }
        Ok(node)
    }

    fn parse_ternary(&mut self) -> Result<Node, ConditionError> {
        self.guard(|parser| {
            let test = parser.parse_binary(1)?;
            if !parser.is_operator("?") {
                return Ok(test);
            }
            parser.take();
            let consequent = parser.parse_ternary()?;
            parser.expect_operator(":")?;
            let alternate = parser.parse_ternary()?;
            Ok(Node::Ternary {
                test: Box::new(test),
                consequent: Box::new(consequent),
                alternate: Box::new(alternate),
            })
        })
    }

    fn parse_binary(&mut self, min_precedence: u8) -> Result<Node, ConditionError> {
        let mut left = self.parse_unary()?;
        loop {
            let token = self.peek().clone();
            let operator = match &token.kind {
                TokenKind::Op(op) => op.clone(),
                _ => break,
            };
            let level = match precedence(&operator) {
                Some(level) if level >= min_precedence => level,
                _ => break,
            };
            self.take();
            let right = self.parse_binary(level + 1)?;
            left = Node::Binary {
                operator,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn parse_unary(&mut self) -> Result<Node, ConditionError> {
        self.guard(|parser| {
            let token = parser.peek().clone();
            if let TokenKind::Op(op) = &token.kind {
                if op == "!" || op == "-" || op == "+" {
                    let operator = op.clone();
                    parser.take();
                    let argument = parser.parse_unary()?;
                    return Ok(Node::Unary {
                        operator,
                        argument: Box::new(argument),
                    });
                }
            }
            parser.parse_postfix()
        })
    }

    fn parse_postfix(&mut self) -> Result<Node, ConditionError> {
        let mut node = self.parse_primary()?;
        loop {
            if self.is_operator(".") || self.is_operator("?.") {
                let chain = self.is_operator("?.");
                self.take();
                if chain && self.is_operator("[") {
                    self.take();
                    let property = self.parse_ternary()?;
                    self.expect_operator("]")?;
                    node = Node::Member {
                        object: Box::new(node),
                        property: Box::new(Property::Computed(Box::new(property))),
                    };
                    continue;
                }
                let token = self.peek().clone();
                let name = match token.kind {
                    TokenKind::Ident(name) => name,
                    _ => {
                        return err(format!("表达式语法错误：位置 {} 应为属性名", token.pos));
                    }
                };
                self.take();
                node = Node::Member {
                    object: Box::new(node),
                    property: Box::new(Property::Named(name)),
                };
                continue;
            }
            if self.is_operator("[") {
                self.take();
                let property = self.parse_ternary()?;
                self.expect_operator("]")?;
                node = Node::Member {
                    object: Box::new(node),
                    property: Box::new(Property::Computed(Box::new(property))),
                };
                continue;
            }
            break;
        }
        Ok(node)
    }

    fn parse_primary(&mut self) -> Result<Node, ConditionError> {
        self.guard(|parser| {
            let token = parser.take();
            match token.kind {
                TokenKind::Number(number) => Ok(Node::Literal(Value::Number(number))),
                TokenKind::Str(text) => Ok(Node::Literal(Value::Str(text))),
                TokenKind::Ident(name) => Ok(match name.as_str() {
                    "true" => Node::Literal(Value::Bool(true)),
                    "false" => Node::Literal(Value::Bool(false)),
                    "null" => Node::Literal(Value::Null),
                    "undefined" => Node::Literal(Value::Undefined),
                    _ => Node::Ident(name),
                }),
                TokenKind::Op(op) if op == "(" => {
                    let node = parser.parse_ternary()?;
                    parser.expect_operator(")")?;
                    Ok(node)
                }
                _ => err(format!("表达式语法错误：位置 {} 缺少值", token.pos)),
            }
        })
    }
}

fn parse_expression(source: &str) -> Result<Node, ConditionError> {
    if source.chars().count() > MAX_LENGTH {
        return err(format!("条件表达式不能超过 {MAX_LENGTH} 个字符"));
    }
    let chars: Vec<char> = source.chars().collect();
    let tokens = tokenize(&chars)?;
    if tokens.len() > MAX_TOKENS {
        return err("条件表达式过长");
    }
    Parser {
        tokens,
        index: 0,
        depth: 0,
    }
    .parse()
}

/// 校验表达式语法；返回 `None` 表示可用（空串也表示「未设置」）。
pub fn validate_condition(source: &str) -> Option<String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return None;
    }
    match parse_expression(trimmed) {
        Ok(_) => None,
        Err(error) => Some(error.0),
    }
}

// ---------------------------------------------------------------------------
// 求值
// ---------------------------------------------------------------------------

/// 求值上下文。
#[derive(Debug, Clone, Default)]
pub struct ConditionContext {
    /// 已解析的响应体（非 JSON 时为 `None`）。
    pub json: Option<Json>,
    /// HTTP 状态码。
    pub status: Option<i64>,
    /// 原始响应体文本。
    pub body: Option<String>,
}

/// JSON 里的标量还原成对应的值类型；对象与数组保持为 `Value::Json`。
///
/// JS 里 JSON 解析出来的就是普通的数字/字符串/布尔/null，
/// 所以比较运算必须看到标量本身，而不是一个包着它的容器。
fn json_to_value(json: &Json) -> Value {
    match json {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::Number(number) => Value::Number(number.as_f64().unwrap_or(f64::NAN)),
        Json::String(text) => Value::Str(text.clone()),
        other => Value::Json(other.clone()),
    }
}

/// 安全取值：中间环节缺失、原型链属性、非对象一律得到 `Missing`。
fn get_property(object: &Value, key: &str) -> Value {
    if object.is_missing() || object.is_nullish() {
        return Value::Missing;
    }
    if key == "__proto__" || key == "prototype" || key == "constructor" {
        return Value::Missing;
    }
    match object {
        Value::Str(text) => {
            if key == "length" {
                return Value::Number(text.chars().count() as f64);
            }
            if let Ok(index) = key.parse::<usize>() {
                if let Some(ch) = text.chars().nth(index) {
                    return Value::Str(ch.to_string());
                }
            }
            Value::Missing
        }
        Value::Json(Json::Object(map)) => match map.get(key) {
            Some(value) => json_to_value(value),
            None => Value::Missing,
        },
        Value::Json(Json::Array(items)) => match key.parse::<usize>() {
            Ok(index) => match items.get(index) {
                Some(value) => json_to_value(value),
                None => Value::Missing,
            },
            Err(_) => Value::Missing,
        },
        Value::Json(Json::Null) => Value::Missing,
        Value::Json(_) => Value::Missing,
        _ => Value::Missing,
    }
}

fn lookup_identifier(name: &str, context: &ConditionContext) -> Value {
    match name {
        "$status" => {
            return context
                .status
                .map(|status| Value::Number(status as f64))
                .unwrap_or(Value::Missing)
        }
        "$body" => return context
            .body
            .clone()
            .map(Value::Str)
            .unwrap_or(Value::Missing),
        "$json" => return context.json.clone().map(Value::Json).unwrap_or(Value::Missing),
        _ => {}
    }
    if let Some(Json::Object(map)) = &context.json {
        if let Some(value) = map.get(name) {
            return json_to_value(value);
        }
    }
    Value::Missing
}

/// 宽松相等（JS 的 `==`）。
fn loose_equal(left: &Value, right: &Value) -> bool {
    if strict_equal(left, right) {
        return true;
    }
    if left.is_nullish() || right.is_nullish() {
        return left.is_nullish() && right.is_nullish();
    }
    match (left, right) {
        (Value::Number(a), Value::Str(b)) => *a == string_to_number(b),
        (Value::Str(a), Value::Number(b)) => string_to_number(a) == *b,
        (Value::Bool(a), other) => loose_equal(&Value::Number(if *a { 1.0 } else { 0.0 }), other),
        (other, Value::Bool(b)) => loose_equal(other, &Value::Number(if *b { 1.0 } else { 0.0 })),
        _ => false,
    }
}

/// 严格相等（JS 的 `===`）。
fn strict_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Missing, Value::Missing) => true,
        (Value::Undefined, Value::Undefined) => true,
        (Value::Null, Value::Null) => true,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        (Value::Number(a), Value::Number(b)) => a == b,
        (Value::Str(a), Value::Str(b)) => a == b,
        // 对象/数组按引用比较；这里无法保持引用语义，结构相同即视为相等。
        (Value::Json(a), Value::Json(b)) => a == b,
        _ => false,
    }
}

fn compare(operator: &str, left: &Value, right: &Value) -> Value {
    if left.is_missing() || right.is_missing() {
        return Value::Missing;
    }
    let result = match operator {
        "=" | "==" => loose_equal(left, right),
        "===" => strict_equal(left, right),
        "!=" => !loose_equal(left, right),
        "!==" => !strict_equal(left, right),
        "<" | "<=" | ">" | ">=" => {
            if let (Value::Str(a), Value::Str(b)) = (left, right) {
                match operator {
                    "<" => a < b,
                    "<=" => a <= b,
                    ">" => a > b,
                    _ => a >= b,
                }
            } else {
                let a = left.to_number();
                let b = right.to_number();
                if a.is_nan() || b.is_nan() {
                    return Value::Bool(false);
                }
                match operator {
                    "<" => a < b,
                    "<=" => a <= b,
                    ">" => a > b,
                    _ => a >= b,
                }
            }
        }
        _ => return Value::Missing,
    };
    Value::Bool(result)
}

struct Evaluator<'a> {
    context: &'a ConditionContext,
    steps: usize,
}

impl<'a> Evaluator<'a> {
    fn evaluate(&mut self, node: &Node) -> Value {
        self.steps += 1;
        if self.steps > MAX_STEPS {
            return Value::Missing;
        }
        match node {
            Node::Literal(value) => value.clone(),
            Node::Ident(name) => lookup_identifier(name, self.context),
            Node::Member { object, property } => {
                let object_value = self.evaluate(object);
                let key = match property.as_ref() {
                    Property::Named(name) => name.clone(),
                    Property::Computed(node) => {
                        let value = self.evaluate(node);
                        if value.is_missing() {
                            return Value::Missing;
                        }
                        value.to_js_string()
                    }
                };
                if object_value.is_missing() {
                    return Value::Missing;
                }
                get_property(&object_value, &key)
            }
            Node::Unary { operator, argument } => {
                let value = self.evaluate(argument);
                // 缺失沿运算链传播，保证 `!(x==0)` 与 `x!=0` 结论一致。
                if value.is_missing() {
                    return Value::Missing;
                }
                if operator == "!" {
                    return Value::Bool(!value.truthy());
                }
                let number = value.to_number();
                if number.is_nan() {
                    return Value::Missing;
                }
                if operator == "-" {
                    Value::Number(-number)
                } else {
                    Value::Number(number)
                }
            }
            Node::Binary {
                operator,
                left,
                right,
            } => {
                let left_value = self.evaluate(left);
                if operator == "&&" {
                    return if left_value.truthy() {
                        self.evaluate(right)
                    } else {
                        left_value
                    };
                }
                if operator == "||" {
                    return if left_value.truthy() {
                        left_value
                    } else {
                        self.evaluate(right)
                    };
                }
                let right_value = self.evaluate(right);
                if matches!(
                    operator.as_str(),
                    "=" | "==" | "===" | "!=" | "!==" | "<" | "<=" | ">" | ">="
                ) {
                    return compare(operator, &left_value, &right_value);
                }
                if left_value.is_missing() || right_value.is_missing() {
                    return Value::Missing;
                }
                // 与 JS 一致：任一操作数为字符串时 `+` 做拼接，否则做数字相加。
                if operator == "+"
                    && (matches!(left_value, Value::Str(_))
                        || matches!(right_value, Value::Str(_)))
                {
                    return Value::Str(format!(
                        "{}{}",
                        left_value.to_js_string(),
                        right_value.to_js_string()
                    ));
                }
                let a = left_value.to_number();
                let b = right_value.to_number();
                if a.is_nan() || b.is_nan() {
                    return Value::Missing;
                }
                match operator.as_str() {
                    "+" => Value::Number(a + b),
                    "-" => Value::Number(a - b),
                    "*" => Value::Number(a * b),
                    "/" => {
                        if b == 0.0 {
                            Value::Missing
                        } else {
                            Value::Number(a / b)
                        }
                    }
                    "%" => {
                        if b == 0.0 {
                            Value::Missing
                        } else {
                            Value::Number(a % b)
                        }
                    }
                    _ => Value::Missing,
                }
            }
            Node::Ternary {
                test,
                consequent,
                alternate,
            } => {
                if self.evaluate(test).truthy() {
                    self.evaluate(consequent)
                } else {
                    self.evaluate(alternate)
                }
            }
        }
    }
}

/// 求值条件表达式。语法错误、运行时异常都视为「不成立」，绝不向外抛出。
///
/// 调用方仍需使用 [`validate_condition`] 在建任务时把语法错误反馈给用户。
pub fn evaluate_condition(source: &str, context: &ConditionContext) -> bool {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return false;
    }
    let node = match parse_expression(trimmed) {
        Ok(node) => node,
        Err(_) => return false,
    };
    let mut evaluator = Evaluator {
        context,
        steps: 0,
    };
    evaluator.evaluate(&node).truthy()
}
