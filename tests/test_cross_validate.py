"""Offline tests for cross_validate — no API keys or network required."""

import json

from cross_validate import (
    _extract_json,
    _load_key_from_config,
    check_key_status,
    validate_file,
)

# ---------------------------------------------------------------- _extract_json

class TestExtractJson:
    def test_pure_json(self):
        obj = {"score": "pass", "issues": []}
        assert _extract_json(json.dumps(obj)) == obj

    def test_markdown_fenced_json(self):
        text = "你的审核结果：\n```json\n{\"score\": \"warn\", \"summary\": \"ok\"}\n```\n"
        assert _extract_json(text) == {"score": "warn", "summary": "ok"}

    def test_markdown_fenced_without_lang(self):
        text = "```\n{\"a\": 1}\n```"
        assert _extract_json(text) == {"a": 1}

    def test_json_embedded_in_prose(self):
        text = '前言：审核如下 {"wrong": } 不匹配的不要。 真实结果 {"score": "fail"} 完。'
        # 第一个平衡对象是 {"score": "fail"}
        assert _extract_json(text) == {"score": "fail"}

    def test_nested_braces(self):
        text = '结论 {"issues": [{"severity": "high"}]} 结束'
        assert _extract_json(text) == {"issues": [{"severity": "high"}]}

    def test_empty_and_none(self):
        assert _extract_json("") is None
        assert _extract_json("完全没有 JSON") is None

    def test_unbalanced_braces_returns_none(self):
        assert _extract_json("{{{") is None


# ------------------------------------------------------- _load_key_from_config

class TestLoadKey:
    def test_returns_env_var_when_set(self, monkeypatch):
        monkeypatch.setenv("ZHIPU_API_KEY", "env-key-12345678")
        assert _load_key_from_config("ZHIPU_API_KEY") == "env-key-12345678"

    def test_empty_when_absent(self, monkeypatch):
        monkeypatch.delenv("ZHIPU_API_KEY", raising=False)
        monkeypatch.setenv("HOME", "/nonexistent-home-dir-xyz")
        assert _load_key_from_config("ZHIPU_API_KEY") == ""


# ------------------------------------------------------------- key status

class TestCheckKeyStatus:
    def test_return_shape(self, monkeypatch):
        monkeypatch.setenv("ZHIPU_API_KEY", "")
        monkeypatch.setenv("DASHSCOPE_API_KEY", "")
        status = check_key_status()
        assert set(status) == {
            "zhipu", "dashscope", "any_available", "zhipu_key_prefix", "dashscope_key_prefix",
        }
        assert status["any_available"] == (status["zhipu"] or status["dashscope"])
        assert isinstance(status["zhipu"], bool)


# ------------------------------------------------------- validate_content

class TestValidateContent:
    def test_no_keys_returns_not_validated(self, monkeypatch):
        monkeypatch.setenv("ZHIPU_API_KEY", "")
        monkeypatch.setenv("DASHSCOPE_API_KEY", "")
        # reload module so the monkeypatched env is read
        import cross_validate.core as core

        monkeypatch.setattr(core, "ZHIPU_API_KEY", "")
        monkeypatch.setattr(core, "DASHSCOPE_API_KEY", "")
        result = core.validate_content("一些内容")
        assert result["validated"] is False
        assert result["score"] == "unknown"
        assert "issue" not in result or result["issues"] == []

    def test_unknown_type_falls_back_to_article(self, monkeypatch):
        import cross_validate.core as core

        monkeypatch.setattr(core, "ZHIPU_API_KEY", "k")
        monkeypatch.setattr(core, "DASHSCOPE_API_KEY", "")
        captured = {}

        def fake_call(system_prompt, user_prompt):
            captured["system_prompt"] = system_prompt
            return json.dumps({"score": "pass", "issues": [], "summary": "ok"})

        monkeypatch.setattr(core, "_call_secondary", fake_call)
        result = core.validate_content("x", content_type="not_a_real_type")
        assert result["validated"] is True
        assert "事实核查员" in captured["system_prompt"]

    def test_truncation_applies(self, monkeypatch):
        import cross_validate.core as core

        monkeypatch.setattr(core, "ZHIPU_API_KEY", "k")
        monkeypatch.setattr(core, "DASHSCOPE_API_KEY", "")
        sent = {}

        def fake_call(system_prompt, user_prompt):
            sent["user_prompt"] = user_prompt
            return json.dumps({"score": "pass", "issues": [], "summary": "ok"})

        monkeypatch.setattr(core, "_call_secondary", fake_call)
        core.validate_content("A" * 100, content_type="article", max_content=50)
        assert len(sent["user_prompt"]) < 200
        assert "已截断" in sent["user_prompt"]

    def test_api_failure_returns_graceful(self, monkeypatch):
        import cross_validate.core as core

        monkeypatch.setattr(core, "ZHIPU_API_KEY", "k")
        monkeypatch.setattr(core, "DASHSCOPE_API_KEY", "")
        monkeypatch.setattr(core, "_call_secondary", lambda s, u: None)
        result = core.validate_content("x")
        assert result["validated"] is False
        assert result["reason"] == "API 调用失败"

    def test_raw_response_when_no_parsable_json(self, monkeypatch):
        import cross_validate.core as core

        monkeypatch.setattr(core, "ZHIPU_API_KEY", "k")
        monkeypatch.setattr(core, "DASHSCOPE_API_KEY", "")
        monkeypatch.setattr(core, "_call_secondary", lambda s, u: "模型没有返回 JSON，只有这段文字。")
        result = core.validate_content("x")
        assert result["validated"] is True
        assert "raw_response" in result
        assert result["score"] == "unknown"


# ------------------------------------------------------- validate_file

class TestValidateFile:
    def test_missing_file(self):
        result = validate_file("/nonexistent/path/file.md")
        assert result["validated"] is False
        assert "文件不存在" in result["reason"]

    def test_reads_existing_file(self, tmp_path, monkeypatch):
        import cross_validate.core as core

        f = tmp_path / "article.md"
        f.write_text("测试内容", encoding="utf-8")
        got = {}

        def fake_validate(content, content_type, sources=None, max_content=4000):
            got["content"] = content
            return {"validated": True, "score": "pass"}

        monkeypatch.setattr(core, "validate_content", fake_validate)
        result = core.validate_file(str(f), "article")
        assert result["score"] == "pass"
        assert got["content"] == "测试内容"


# ------------------------------------------------------- CLI smoke

class TestCLI:
    def test_console_script_installed(self):
        from cross_validate.core import main

        assert callable(main)