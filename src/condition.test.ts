import { describe, expect, test } from "bun:test";
import { evaluateCondition, validateCondition } from "./condition";

const successBody = {
  ok: true,
  data: {
    result: {
      checktime: 1794828938930,
      description: "19:35在高新人才大厦签退成功",
      nexttime: 1794882420999,
      remindtype: 0,
      checkwarn: null,
    },
    applied: true,
  },
  error: null,
  status: { checkIn: 1, checkOut: 1 },
};

const failureBody = {
  ok: false,
  data: {
    needsMemo: false,
    error: { kind: "business", code: 900, explanation: "不在规定时间，不允许打卡" },
  },
};

function evalJson(expression: string, json: unknown = successBody, status: number | null = 200): boolean {
  return evaluateCondition(expression, {
    json,
    status,
    body: json === null ? null : JSON.stringify(json),
  });
}

describe("validateCondition", () => {
  test("accepts valid expressions and empty strings", () => {
    expect(validateCondition("")).toBeNull();
    expect(validateCondition("   ")).toBeNull();
    expect(validateCondition("data.result.remindtype=0")).toBeNull();
    expect(validateCondition('data.error==null && $status=200')).toBeNull();
    expect(validateCondition("data?.result?.[0] != undefined ? 1 : 0")).toBeNull();
  });

  test("reports syntax errors with a Chinese message", () => {
    expect(validateCondition("data.")).toContain("语法错误");
    expect(validateCondition("data.result ==")).toContain("语法错误");
    expect(validateCondition("(data.ok")).toContain("语法错误");
    expect(validateCondition("data.ok ? 1")).toContain("语法错误");
    expect(validateCondition("data.ok @ 1")).toContain("不支持的字符");
  });

  test("rejects oversized expressions", () => {
    expect(validateCondition(`data.result = ${"9".repeat(1_100)}`)).toContain("不能超过");
  });

  test("keeps `?.` followed by a digit as a ternary (JS grammar)", () => {
    // `true?.5:0` 在 JS 里是 `true ? .5 : 0`，不能把 `?.` 吞成可选链。
    expect(validateCondition("true?.5:0")).toBeNull();
    expect(evaluateCondition("true?.5:0", { json: null, status: 200, body: "" })).toBe(true);
    expect(evaluateCondition("false?.5:0", { json: null, status: 200, body: "" })).toBe(false);
  });
});

describe("evaluateCondition - 安全路径取值", () => {
  test("nested paths resolve normally", () => {
    expect(evalJson("data.result.remindtype=0")).toBe(true);
    expect(evalJson("data.result.checkwarn=null")).toBe(true);
    expect(evalJson("ok=true")).toBe(true);
    expect(evalJson("status.checkIn=1")).toBe(true);
  });

  test("missing intermediate path does not throw and fails the condition", () => {
    expect(evalJson("data.result.missing=0")).toBe(false);
    expect(evalJson("data.result.missing!=0")).toBe(false);
    expect(evalJson("data.nope.deep.value=1")).toBe(false);
    expect(evalJson("data.result.remindtype.deep=0")).toBe(false);
  });

  test("optional chaining and computed access are safe", () => {
    expect(evalJson("data?.result?.remindtype=0")).toBe(true);
    expect(evalJson('data["result"]["remindtype"]=0')).toBe(true);
    expect(evalJson("data.result['checktime']=1794828938930")).toBe(true);
    expect(evalJson("data['missing']?.deep=0")).toBe(false);
  });

  test("array index access works", () => {
    const body = { list: [{ code: 0 }, { code: 900 }] };
    expect(evalJson("list[0].code=0", body)).toBe(true);
    expect(evalJson("list[1].code=900", body)).toBe(true);
    expect(evalJson("list[5].code=0", body)).toBe(false);
  });

  test("string index access works", () => {
    expect(
      evaluateCondition("$body[0]='a'", { json: null, status: 200, body: "abc" }),
    ).toBe(true);
    expect(
      evaluateCondition("$body[3]='a'", { json: null, status: 200, body: "abc" }),
    ).toBe(false);
  });

  test("prototype keys are blocked", () => {
    expect(evalJson("data.constructor=1")).toBe(false);
    expect(evalJson("data.__proto__=1")).toBe(false);
  });

  test("non-JSON body makes paths missing", () => {
    expect(evaluateCondition("data.result.remindtype=0", { json: null, status: 200, body: "plain text" })).toBe(false);
    expect(evaluateCondition("$status=200", { json: null, status: 200, body: "plain text" })).toBe(true);
  });
});

describe("evaluateCondition - 比较与类型转换", () => {
  test("= is loose equality: string 0 and number 0 both match", () => {
    const zero = { value: 0 };
    const zeroString = { value: "0" };
    expect(evalJson("value=0", zero)).toBe(true);
    expect(evalJson("value=0", zeroString)).toBe(true);
    expect(evalJson("value==0", zeroString)).toBe(true);
    expect(evalJson("value===0", zeroString)).toBe(false);
    expect(evalJson("value===0", zero)).toBe(true);
  });

  test("!= undefined / != null / !== distinctions", () => {
    // JS 宽松相等下 null == undefined，故 null != undefined 为 false；
    // 严格比较可区分二者。
    expect(evalJson("error!=undefined")).toBe(false);
    expect(evalJson("error!=null")).toBe(false);
    expect(evalJson("error!==undefined")).toBe(true);
    expect(evalJson("error!==null")).toBe(false);
    expect(evalJson("data.error.code!==null")).toBe(false); // 路径不存在
    expect(evalJson("error===null")).toBe(true);
    expect(evalJson("data.result.missing!=undefined")).toBe(false); // 路径没取到 -> 不成立
    expect(evalJson("data.result.missing==undefined")).toBe(false);
  });

  test("relational operators", () => {
    expect(evalJson("data.result.checktime>0")).toBe(true);
    expect(evalJson("data.result.nexttime>data.result.checktime")).toBe(true);
    expect(evalJson("data.result.remindtype<1")).toBe(true);
    expect(evalJson('data.result.description>"19"')).toBe(true);
  });

  test("arithmetic", () => {
    expect(evalJson("data.result.remindtype+1=1")).toBe(true);
    expect(evalJson("data.result.checktime-data.result.checktime=0")).toBe(true);
    expect(evalJson("2*3=6")).toBe(true);
    expect(evalJson("7%3=1")).toBe(true);
  });

  test("+ concatenates when either side is a string (JS semantics)", () => {
    expect(evalJson("prefix+id='AB12'", { prefix: "AB", id: 12 })).toBe(true);
    expect(evalJson("id+prefix='12AB'", { prefix: "AB", id: 12 })).toBe(true);
    expect(evalJson("'5'+3='53'", {})).toBe(true);
    expect(evalJson("2+3=5", {})).toBe(true); // 两边都是数字仍做加法
  });
});

describe("evaluateCondition - 逻辑、三元与元变量", () => {
  test("logical operators short-circuit", () => {
    expect(evalJson("ok=true && data.result.remindtype=0")).toBe(true);
    expect(evalJson("ok=false || data.result.remindtype=0")).toBe(true);
    expect(evalJson("ok=false && data.result.remindtype=0")).toBe(false);
    expect(evalJson("!error")).toBe(true); // error=null，!null === true
    expect(evalJson("!!error")).toBe(false); // !!null === false
    expect(evalJson("!data.error")).toBe(false); // 路径不存在，缺失传播后不成立
  });

  test("ternary expressions", () => {
    expect(evalJson("data.result.remindtype=0 ? true : false")).toBe(true);
    expect(evalJson("data.result.remindtype=1 ? true : false")).toBe(false);
    expect(evalJson("ok=true ? data.result.remindtype=0 : false")).toBe(true);
  });

  test("$status and $body meta variables", () => {
    expect(evalJson("$status=200")).toBe(true);
    expect(evalJson("$status>=200 && $status<300")).toBe(true);
    expect(evalJson("$status=500")).toBe(false);
    expect(evaluateCondition('$body.includes("x")', { json: null, status: 200, body: "abcdef" })).toBe(false);
  });

  test("true/false/null/undefined literals", () => {
    expect(evalJson("true")).toBe(true);
    expect(evalJson("false")).toBe(false);
    expect(evalJson("null")).toBe(false);
    expect(evalJson("undefined")).toBe(false);
  });

  test("missing values propagate so `!(x==0)` matches `x!=0`", () => {
    // JS 恒等式：x != 0 等价于 !(x == 0)。缺失路径下两者都应「不成立」。
    expect(evalJson("data.missing!=0")).toBe(false);
    expect(evalJson("!(data.missing=0)")).toBe(false);
    expect(evalJson("data.missing=0 ? true : false")).toBe(false);
  });

  test("never throws on malformed runtime input", () => {
    expect(evaluateCondition("data.", { json: successBody, status: 200, body: "{}" })).toBe(false);
    expect(evaluateCondition("", { json: successBody, status: 200, body: "{}" })).toBe(false);
    expect(evaluateCondition("1/0=1", { json: successBody, status: 200, body: "{}" })).toBe(false);
  });
});

describe("evaluateCondition - 真实场景", () => {
  test("区分打卡成功与业务失败的响应", () => {
    expect(evalJson("data.result.remindtype=0", successBody)).toBe(true);
    expect(evalJson("data.result.remindtype=0", failureBody)).toBe(false);
    expect(evalJson("data.error.code=900", failureBody)).toBe(true);
    expect(evalJson("data.error.code=900", successBody)).toBe(false);
    expect(evalJson("ok=true && data.result.checkwarn=null", successBody)).toBe(true);
    expect(evalJson("ok=true && data.result.checkwarn=null", failureBody)).toBe(false);
  });
});
