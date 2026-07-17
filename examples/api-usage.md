# Cross-Validate Python API 使用示例

## 导入

```python
import sys
sys.path.insert(0, "/path/to/cross-validate")
from cross_validate import validate_content, validate_file, check_key_status
```

## 检查 API 配置

```python
status = check_key_status()
print(status)
# {'zhipu': True, 'dashscope': False, 'any_available': True, ...}
```

## 审核文章

```python
result = validate_content("本文讨论了 Python 异步编程的优势...", content_type="article")
print(f"评分: {result['score']}")
print(f"总结: {result['summary']}")
for issue in result.get('issues', []):
    print(f"  [{issue['severity']}] {issue['description']}")
```

## 审核代码

```python
code = """
def add(a, b):
    return a + b

result = add(1)  # 缺少参数
"""
result = validate_content(code, content_type="code")
if result.get("score") == "fail":
    print("代码存在问题，需要修改")
```

## 审核文件

```python
result = validate_file("path/to/file.py", content_type="code")
```

## 批量审核

```python
import glob

for py_file in glob.glob("src/**/*.py", recursive=True):
    result = validate_file(py_file, content_type="code")
    issues = result.get("issues", [])
    if issues:
        print(f"{py_file}: {len(issues)} 个问题")
```

## 异常处理

```python
result = validate_content("内容", "article")
if not result.get("validated"):
    print(f"审核失败: {result.get('reason', '未知错误')}")
elif result.get("score") == "fail":
    print("内容未通过审核")
else:
    print("审核通过")
```
