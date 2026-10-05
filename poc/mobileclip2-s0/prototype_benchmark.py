import argparse
import json
import statistics
import time
from pathlib import Path

import torch
import open_clip
from PIL import Image

ROOT = Path(__file__).resolve().parent

def sync(device):
    if device.type == "cuda":
        torch.cuda.synchronize()

def percentile(values, q):
    values=sorted(values)
    if not values:
        return 0.0
    idx=(len(values)-1)*q
    lo=int(idx); hi=min(lo+1,len(values)-1); f=idx-lo
    return values[lo]*(1-f)+values[hi]*f

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--samples",default=str(ROOT/"samples"))
    ap.add_argument("--device",default="cuda" if torch.cuda.is_available() else "cpu")
    ap.add_argument("--json-out")
    args=ap.parse_args()
    device=torch.device(args.device)

    if device.type=="cuda":
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()

    t0=time.perf_counter()
    model,_,preprocess=open_clip.create_model_and_transforms("hf-hub:timm/MobileCLIP2-S0-OpenCLIP")
    model.eval().to(device)
    sync(device)
    load_ms=(time.perf_counter()-t0)*1000

    samples_dir=Path(args.samples)
    manifest=json.loads((samples_dir/"manifest.json").read_text(encoding="utf-8"))
    embeddings={}
    latencies={}

    # warmup
    warm=preprocess(Image.open(samples_dir/manifest[0]["file"]).convert("RGB")).unsqueeze(0).to(device)
    with torch.inference_mode():
        model.encode_image(warm)
    sync(device)

    for item in manifest:
        image=preprocess(Image.open(samples_dir/item["file"]).convert("RGB")).unsqueeze(0).to(device)
        sync(device)
        t=time.perf_counter()
        with torch.inference_mode():
            emb=model.encode_image(image)
            emb=emb/emb.norm(dim=-1,keepdim=True)
        sync(device)
        latencies[item["file"]]=(time.perf_counter()-t)*1000
        embeddings[item["file"]]=emb.squeeze(0)

    rows=[]
    for item in manifest:
        test_emb=embeddings[item["file"]]
        labels=sorted({x["expected"] for x in manifest})
        scores={}
        for label in labels:
            train=[
                embeddings[x["file"]]
                for x in manifest
                if x["expected"]==label and x["file"]!=item["file"]
            ]
            proto=torch.stack(train).mean(dim=0)
            proto=proto/proto.norm()
            scores[label]=float((test_emb@proto).item())

        ranked=sorted(scores.items(),key=lambda x:x[1],reverse=True)
        top1=ranked[0][0]
        rows.append({
            "file":item["file"],
            "expected":item["expected"],
            "predicted":top1,
            "correct":top1==item["expected"],
            "cosine":round(ranked[0][1],4),
            "margin":round(ranked[0][1]-ranked[1][1],4),
            "scores":{k:round(v,4) for k,v in ranked},
            "encode_ms":round(latencies[item["file"]],3),
        })

    accuracy=sum(r["correct"] for r in rows)/len(rows)
    ts=list(latencies.values())
    result={
        "model":"timm/MobileCLIP2-S0-OpenCLIP",
        "method":"leave-one-out image prototype classification",
        "device":str(device),
        "sample_count":len(rows),
        "accuracy":round(accuracy,4),
        "load_ms":round(load_ms,1),
        "encode_latency_ms":{
            "mean":round(statistics.mean(ts),3),
            "p50":round(percentile(ts,.5),3),
            "p95":round(percentile(ts,.95),3),
        },
        "cuda_peak_allocated_mb":round(torch.cuda.max_memory_allocated()/1024/1024,1) if device.type=="cuda" else None,
        "rows":rows,
    }
    text=json.dumps(result,indent=2)
    print(text)
    if args.json_out:
        Path(args.json_out).write_text(text,encoding="utf-8")

if __name__=="__main__":
    main()
