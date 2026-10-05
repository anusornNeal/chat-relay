import argparse
import json
import statistics
import time
from pathlib import Path

import torch
import open_clip
from PIL import Image

ROOT = Path(__file__).resolve().parent

LABEL_PROMPTS = {
    "calendar": [
        "a calendar app screen showing a month grid",
        "a user interface displaying a calendar with dates",
    ],
    "loading": [
        "a loading screen with a progress indicator",
        "an app screen that is currently loading",
    ],
    "error_dialog": [
        "an application screen showing an error dialog",
        "a software error message with a retry button",
    ],
    "success": [
        "a success confirmation screen with a check mark",
        "an application screen confirming an action succeeded",
    ],
    "settings": [
        "an application settings screen with rows of options",
        "a settings menu in a software application",
    ],
}

def sync(device):
    if device.type == "cuda":
        torch.cuda.synchronize()

def percentile(values, q):
    ordered=sorted(values)
    if not ordered:
        return 0.0
    idx=(len(ordered)-1)*q
    lo=int(idx); hi=min(lo+1,len(ordered)-1)
    frac=idx-lo
    return ordered[lo]*(1-frac)+ordered[hi]*frac

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--samples", default=str(ROOT/"samples"))
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    ap.add_argument("--repeat", type=int, default=10)
    ap.add_argument("--real-image")
    ap.add_argument("--json-out")
    args=ap.parse_args()

    device=torch.device(args.device)
    if device.type=="cuda":
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()

    t0=time.perf_counter()
    model, _, preprocess = open_clip.create_model_and_transforms(
        "hf-hub:timm/MobileCLIP2-S0-OpenCLIP"
    )
    tokenizer = open_clip.get_tokenizer("hf-hub:timm/MobileCLIP2-S0-OpenCLIP")
    model.eval().to(device)
    sync(device)
    load_ms=(time.perf_counter()-t0)*1000

    prompts=[]
    prompt_labels=[]
    for label, texts in LABEL_PROMPTS.items():
        for text in texts:
            prompts.append(text)
            prompt_labels.append(label)

    with torch.inference_mode():
        tokens=tokenizer(prompts).to(device)
        txt=model.encode_text(tokens)
        txt=txt/txt.norm(dim=-1,keepdim=True)

    samples_dir=Path(args.samples)
    manifest=json.loads((samples_dir/"manifest.json").read_text(encoding="utf-8"))
    rows=[]
    timings=[]

    def classify(path):
        image=preprocess(Image.open(path).convert("RGB")).unsqueeze(0).to(device)
        sync(device)
        start=time.perf_counter()
        with torch.inference_mode():
            img=model.encode_image(image)
            img=img/img.norm(dim=-1,keepdim=True)
            raw=(100.0*img@txt.T).squeeze(0)
            prompt_probs=raw.softmax(dim=-1)
        sync(device)
        elapsed=(time.perf_counter()-start)*1000

        scores={label:0.0 for label in LABEL_PROMPTS}
        for idx,label in enumerate(prompt_labels):
            scores[label]+=float(prompt_probs[idx].item())
        total=sum(scores.values()) or 1.0
        scores={k:v/total for k,v in scores.items()}
        ranked=sorted(scores.items(), key=lambda x:x[1], reverse=True)
        return ranked, elapsed

    # one warm-up avoids counting CUDA/kernel startup in steady-state latency
    first=samples_dir/manifest[0]["file"]
    classify(first)

    for item in manifest:
        ranked, elapsed=classify(samples_dir/item["file"])
        timings.append(elapsed)
        top1, conf=ranked[0]
        margin=conf-ranked[1][1]
        rows.append({
            "file": item["file"],
            "expected": item["expected"],
            "predicted": top1,
            "correct": top1==item["expected"],
            "confidence": round(conf,4),
            "margin": round(margin,4),
            "scores": {k:round(v,4) for k,v in ranked},
            "latency_ms": round(elapsed,3),
        })

    # repeated inference on one cached image for stable timing
    repeat_times=[]
    for _ in range(max(1,args.repeat)):
        _, elapsed=classify(first)
        repeat_times.append(elapsed)

    real_probe=None
    if args.real_image:
        ranked, elapsed=classify(Path(args.real_image))
        real_probe={
            "file": str(args.real_image),
            "predicted": ranked[0][0],
            "confidence": round(ranked[0][1],4),
            "margin": round(ranked[0][1]-ranked[1][1],4),
            "scores": {k:round(v,4) for k,v in ranked},
            "latency_ms": round(elapsed,3),
        }

    accuracy=sum(r["correct"] for r in rows)/len(rows)
    result={
        "model":"timm/MobileCLIP2-S0-OpenCLIP",
        "device":str(device),
        "torch":torch.__version__,
        "sample_count":len(rows),
        "accuracy":round(accuracy,4),
        "load_ms":round(load_ms,1),
        "dataset_latency_ms":{
            "mean":round(statistics.mean(timings),3),
            "p50":round(percentile(timings,.5),3),
            "p95":round(percentile(timings,.95),3),
        },
        "steady_state_latency_ms":{
            "mean":round(statistics.mean(repeat_times),3),
            "p50":round(percentile(repeat_times,.5),3),
            "p95":round(percentile(repeat_times,.95),3),
        },
        "cuda_peak_allocated_mb": round(torch.cuda.max_memory_allocated()/1024/1024,1) if device.type=="cuda" else None,
        "rows":rows,
        "real_probe":real_probe,
    }
    text=json.dumps(result,indent=2)
    print(text)
    if args.json_out:
        Path(args.json_out).write_text(text,encoding="utf-8")

if __name__=="__main__":
    main()
