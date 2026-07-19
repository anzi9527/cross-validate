#!/usr/bin/env python3
"""
跨模型交叉校验工具
用第二个模型审核 AI 生成内容，降低幻觉

支持：
- 智谱 GLM-4-Flash（免费额度）
- 通义千问 qwen-turbo（免费额度，需手动注册 Key）

使用方法：
1. 去 https://open.bigmodel.cn/usercenter/project 注册智谱 API Key（免费）
   或 https://help.aliyun.com/zh/model-studio/ 注册通义千问（免费额度）
2. 把 Key 填到 openclaw.json 的 env 里：
   "env": {
     "ZHIPU_API_KEY": "your-key-here",
     "DASHSCOPE_API_KEY": "your-key-here"
   }
   或直接设置环境变量
"""

import io
import re
import sys
import json
import os
import urllib.request
from typing import Optional

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# 从 openclaw.json 读取 API Key
def _load_key_from_config(key_name: str) -> str:
    """从 openclaw 配置读取 Key"""
    # 1. 先检查环境变量
    val = os.environ.get(key_name, "")
    if val:
        return val

    # 2. 从 openclaw.json 读取
    config_path = os.path.expanduser("~/.openclaw/openclaw.json")
    try:
        with open(config_path, encoding="utf-8-sig") as f:
            cfg = json.load(f)
        val = cfg.get("env", {}).get(key_name, "")
        if val:
            return val
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    return ""


ZHIPU_API_KEY = _load_key_from_config("ZHIPU_API_KEY")
DASHSCOPE_API_KEY = _load_key_from_config("DASHSCOPE_API_KEY")


def _call_zhipu(system_prompt: str, user_prompt: str) -> Optional[str]:
    """调用智谱 GLM-4-Flash（免费版）"""
    if not ZHIPU_API_KEY:
        return None

    url = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
    data = json.dumps({
        "model": "GLM-4-Flash",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.3,
        "max_tokens": 1024,
    }).encode()

    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {ZHIPU_API_KEY}",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            result = json.loads(resp.read().decode())
            return result["choices"][0]["message"]["content"]
    except Exception as e:
        print(f"  ⚠️ 智谱调用失败: {e}", file=sys.stderr)
        return None


def _call_dashscope(system_prompt: str, user_prompt: str) -> Optional[str]:
    """调用通义千问 qwen-turbo（免费额度）"""
    if not DASHSCOPE_API_KEY:
        return None

    url = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
    data = json.dumps({
        "model": "qwen-turbo",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.3,
        "max_tokens": 1024,
    }).encode()

    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {DASHSCOPE_API_KEY}",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            result = json.loads(resp.read().decode())
            return result["choices"][0]["message"]["content"]
    except Exception as e:
        print(f"  ⚠️ 通义千问调用失败: {e}", file=sys.stderr)
        return None


def _call_secondary(system_prompt: str, user_prompt: str) -> Optional[str]:
    """调用已配置的次要模型（优先智谱，回退到通义）"""
    result = _call_zhipu(system_prompt, user_prompt)
    if result:
        return result
    return _call_dashscope(system_prompt, user_prompt)


def validate_content(content: str, content_type: str = "article", sources: Optional[str] = None) -> dict:
    """
    用第二个模型审核内容

    参数:
        content: 要审核的内容文本
        content_type: 内容类型
            - "article": 技术文章/日报
            - "code": Python 代码片段
            - "case_study": 踩坑案例/解决方案
        sources: 数据来源描述/链接列表（可选）。提供后，
                 审核 prompt 会附带这些来源信息，帮助模型
                 基于外部源判断事实而非依赖自己的知识库。

    返回:
        {
            "validated": True/False,  # 是否成功执行了审核
            "model": "zhipu" / "dashscope" / "",
            "issues": [
                {"severity": "high"|"medium"|"low", "type": "factual_error"|"logic_issue"|"code_bug"|"suggestion", "description": "..."}
            ],
            "summary": "审核总结",
            "score": "pass"|"warn"|"fail"
        }
    """
    if not ZHIPU_API_KEY and not DASHSCOPE_API_KEY:
        return {
            "validated": False,
            "reason": "未配置校验 API Key（请注册智谱 https://open.bigmodel.cn 获取免费 Key）",
            "issues": [],
            "score": "unknown",
        }

    # 根据内容类型选择 prompt
    if content_type == "code":
        system_prompt = """你是一个资深的 Python 代码审查专家。请严格检查以下代码：
1. 语法是否正确
2. 是否有逻辑错误或边界情况
3. 变量命名是否合理
4. 是否有安全漏洞
5. 依赖是否合理

用 JSON 格式输出审核结果：
{"issues": [{"severity":"high|medium|low","type":"code_bug|logic_issue|suggestion","description":"..."}], "summary":"总体评价（一句话）", "score":"pass|warn|fail"}"""
    elif content_type == "case_study":
        system_prompt = """你是一个经验丰富的 AI 工程落地专家。请审核以下踩坑案例：
1. 问题描述是否真实可信
2. 根因分析是否合理
3. 解决方案是否可复现
4. 是否有明显的事实错误

用 JSON 格式输出审核结果：
{"issues": [{"severity":"high|medium|low","type":"factual_error|logic_issue|suggestion","description":"..."}], "summary":"总体评价", "score":"pass|warn|fail"}"""
    else:
        system_prompt = """你是一个严谨的事实核查员和技术编辑。请审核以下内容：
1. 是否有事实错误
2. 逻辑是否自洽
3. 是否有夸大或误导性表述
4. 引用和数字是否合理

用 JSON 格式输出审核结果：
{"issues": [{"severity":"high|medium|low","type":"factual_error|logic_issue|suggestion","description":"..."}], "summary":"总体评价", "score":"pass|warn|fail"}"""

    # 限制内容长度
    max_content = 4000
    truncated = content[:max_content]
    if len(content) > max_content:
        truncated += "\n...（内容过长已截断，仅审核前4000字）"

    if sources:
        source_block = f"\n\n=== 数据来源信息（请基于以下来源判断事实，不要仅依赖你自己的知识库）===\n{sources[:2000]}\n=== 来源信息结束 ===\n"
    else:
        source_block = ""

    user_prompt = f"请审核以下{'代码' if content_type == 'code' else '案例' if content_type == 'case_study' else '文章'}：{source_block}\n\n{truncated}"

    response = _call_secondary(system_prompt, user_prompt)
    if not response:
        return {
            "validated": False,
            "reason": "API 调用失败",
            "issues": [],
            "score": "unknown",
        }

    # 尝试解析 JSON（模型可能把 JSON 包在 markdown 代码块里）
    model_used = "zhipu" if ZHIPU_API_KEY else "dashscope"

    def _try_extract_json(text):
        # 尝试直接解析
        try:
            return json.loads(text)
        except (json.JSONDecodeError, ValueError):
            pass
        # 尝试从 markdown 代码块提取
        m = re.search(r"```(?:json)?\s*\n?([\s\S]*?)\n?```", text)
        if m:
            try:
                return json.loads(m.group(1))
            except (json.JSONDecodeError, ValueError):
                pass
        # 尝试找第一个 { ... } JSON 对象
        brace_match = None
        depth = 0
        start = -1
        for i, ch in enumerate(text):
            if ch == '{':
                if depth == 0:
                    start = i
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0 and start >= 0:
                    try:
                        return json.loads(text[start:i+1])
                    except (json.JSONDecodeError, ValueError):
                        start = -1
        return None

    parsed = _try_extract_json(response)
    if parsed and isinstance(parsed, dict) and "score" in parsed:
        parsed["validated"] = True
        parsed["model"] = model_used
        return parsed

    # 如果模型没输出可解析的 JSON，返回原始文本
    return {
        "validated": True,
        "model": model_used,
        "raw_response": response,
        "issues": [],
        "summary": response[:500],
        "score": "unknown",
    }


def validate_file(filepath: str, content_type: str = "article", sources: Optional[str] = None) -> dict:
    """审核文件"""
    try:
        with open(filepath, encoding="utf-8") as f:
            content = f.read()
    except FileNotFoundError:
        return {"validated": False, "reason": f"文件不存在: {filepath}"}

    return validate_content(content, content_type, sources=sources)


def check_key_status() -> dict:
    """检查 API Key 配置状态"""
    return {
        "zhipu": bool(ZHIPU_API_KEY),
        "dashscope": bool(DASHSCOPE_API_KEY),
        "any_available": bool(ZHIPU_API_KEY or DASHSCOPE_API_KEY),
        "zhipu_key_prefix": ZHIPU_API_KEY[:8] + "..." if ZHIPU_API_KEY else "",
        "dashscope_key_prefix": DASHSCOPE_API_KEY[:8] + "..." if DASHSCOPE_API_KEY else "",
    }


def main():
    args = sys.argv[1:]

    if not args:
        status = check_key_status()
        print("🔍 跨模型交叉校验工具")
        print(f"\nAPI Key 状态:")
        print(f"  智谱 GLM-4-Flash: {'✅ 已配置' if status['zhipu'] else '❌ 未配置'}")
        print(f"  通义千问 qwen-turbo: {'✅ 已配置' if status['dashscope'] else '❌ 未配置'}")
        print(f"  总状态: {'✅ 可用' if status['any_available'] else '❌ 不可用（需注册 API Key）'}")
        print(f"\n用法:")
        print(f"  python3 cross_validate.py <文件路径> [article|code|case_study] [--sources=<来源文件>]")
        print(f"  python3 cross_validate.py --text <\"文本内容\"> [article|code|case_study] [--sources=<来源文件>]")
        print(f"  python3 cross_validate.py --check  查看 Key 状态")
        return

    if args[0] == "--check":
        status = check_key_status()
        print(json.dumps(status, indent=2, ensure_ascii=False))
        return

    # 解析可选的数据源文件参数
    source_text = None
    file_args = [a for a in args if not a.startswith("--sources=")]
    source_arg = [a for a in args if a.startswith("--sources=")]
    if source_arg:
        src_path = source_arg[0].split("=", 1)[1]
        try:
            with open(src_path, encoding="utf-8") as f:
                source_text = f.read()[:2000]
        except Exception as e:
            print(f"⚠️ 无法读取数据源文件 {src_path}: {e}", file=sys.stderr)

    if file_args[0] == "--text" and len(file_args) >= 2:
        content = file_args[1]
        content_type = file_args[2] if len(file_args) >= 3 else "article"
        result = validate_content(content, content_type, sources=source_text)
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return

    # 审核文件
    filepath = file_args[0]
    content_type = file_args[1] if len(file_args) >= 2 else "article"
    result = validate_file(filepath, content_type, sources=source_text)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
