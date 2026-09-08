from pathlib import Path
import runpy

ROOT = Path(__file__).resolve().parents[1]
namespace = runpy.run_path(str(ROOT / ".github" / "task-6-2-v2.py"), run_name="task_6_2_v2")
original_replace_span = namespace["replace_span"]


def fixed_replace_span(text: str, start_marker: str, end_marker: str, replacement: str, label: str) -> str:
    if label == "remove local interrupted-upload rollback":
        replacement = ""
    return original_replace_span(text, start_marker, end_marker, replacement, label)


main = namespace["main"]
main.__globals__["replace_span"] = fixed_replace_span
main()
