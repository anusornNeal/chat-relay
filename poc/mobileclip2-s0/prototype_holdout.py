import argparse
import json
import statistics
import time
from pathlib import Path
import torch
import open_clip
from PIL import Image

ROOT=Path(__file__).resolve().parent

def sync(device):
    if device.type=="cuda": torch.cuda.synchronize()

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--train",default=str(ROOT/"samples"))
    ap.add_argument("--test",default=str(ROOT/"samples-hard"))
    ap.add_argument("--device",default="cuda" if torch.cuda.is_available() else "cpu")
    ap.add_argument("--real-image")
    ap.add_argument("--json-out")
    args=ap.parse_args()
    device=torch.device(args.device)
    if device.type=="cuda":
        torch.cuda.empty_cache(); torch.cuda.reset_peak_memory_stats()

    t0=time.perf_counter()
    model,_,preprocess=open_clip.create_model_and_transforms("hf-hub:timm/MobileCLIP2-S0-OpenCLIP")
    model.eval().to(device); sync(device)
    load_ms=(time.perf_counter()-t0)*1000

    def encode(path):
        image=preprocess(Image.open(path).convert("RGB")).unsqueeze(0).to(device)
        sync(device); t=time.perf_counter()
        with torch.inference_mode():
            e=model.encode_image(image); e=e/e.norm(dim=-1,keepdim=True)
        sync(device)
        return e.squeeze(0),(time.perf_counter()-t)*1000

    train_dir=Path(args.train); test_dir=Path(args.test)
    train_manifest=json.loads((train_dir/"manifest.json").read_text(encoding="utf-8"))
    test_manifest=json.loads((test_dir/"manifest.json").read_text(encoding="utf-8"))

    by_label={}
    for item in train_manifest:
        e,_=encode(train_dir/item["file"])
        by_label.setdefault(item["expected"],[]).append(e)
    prototypes={}
    for label,vecs in by_label.items():
        p=torch.stack(vecs).mean(dim=0); prototypes[label]=p/p.norm()

    rows=[]; times=[]
    def classify(path,expected=None):
        e,ms=encode(path); times.append(ms)
        scores={label:float((e@p).item()) for label,p in prototypes.items()}
        ranked=sorted(scores.items(),key=lambda x:x[1],reverse=True)
        row={"file":str(path),"predicted":ranked[0][0],"cosine":round(ranked[0][1],4),"margin":round(ranked[0][1]-ranked[1][1],4),"scores":{k:round(v,4) for k,v in ranked},"encode_ms":round(ms,3)}
        if expected is not None:
            row.update({"expected":expected,"correct":ranked[0][0]==expected})
        return row

    for item in test_manifest:
        rows.append(classify(test_dir/item["file"],item["expected"]))

    real=classify(Path(args.real_image)) if args.real_image else None
    acc=sum(r["correct"] for r in rows)/len(rows)
    result={"model":"timm/MobileCLIP2-S0-OpenCLIP","method":"fixed image prototypes -> hard holdout","device":str(device),"train_examples":len(train_manifest),"test_examples":len(test_manifest),"accuracy":round(acc,4),"load_ms":round(load_ms,1),"encode_mean_ms":round(statistics.mean(times),3),"cuda_peak_allocated_mb":round(torch.cuda.max_memory_allocated()/1024/1024,1) if device.type=="cuda" else None,"rows":rows,"real_probe":real}
    text=json.dumps(result,indent=2); print(text)
    if args.json_out: Path(args.json_out).write_text(text,encoding="utf-8")

if __name__=="__main__": main()
