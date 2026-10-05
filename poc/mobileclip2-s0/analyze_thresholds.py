import argparse
import json
from pathlib import Path

ap=argparse.ArgumentParser()
ap.add_argument("result")
args=ap.parse_args()
rows=json.loads(Path(args.result).read_text(encoding="utf-8"))["rows"]
print("threshold coverage accepted_accuracy accepted")
for threshold in [0.00,0.02,0.03,0.05,0.08,0.10,0.15,0.20]:
    accepted=[r for r in rows if r["margin"]>=threshold]
    coverage=len(accepted)/len(rows)
    accuracy=(sum(bool(r["correct"]) for r in accepted)/len(accepted)) if accepted else 0.0
    print(f"{threshold:.2f} {coverage:.2f} {accuracy:.3f} {len(accepted)}")
