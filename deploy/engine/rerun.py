# Perskaičiuoja projektą nuo nurodyto etapo (ankstesni etapai nekartojami). Pvz. OpenMVS su GPU:
#   docker exec -e OPENMVS_CUDA_DEVICE=-1 -i <variklio konteineris> python3 - <projekto ID> dense < deploy\engine\rerun.py
import json
import os
import sys

sys.path.insert(0, "/app")
import pipeline  # noqa: E402


def main(task, start="dense"):
    root = task if os.path.isdir(task) else os.path.join("/engine-data", task)
    names = [s for s, _ in pipeline.STAGES]
    if start not in names:
        sys.exit("Nežinomas etapas %s (galimi: %s)" % (start, ", ".join(names)))
    quality = "high"
    try:
        quality = json.load(open(os.path.join(root, "work", ".done_dataset"))).get("quality", quality)
    except (OSError, ValueError):
        pass
    # OpenMVS darbo aplankas po tekstūros ištrinamas: tinklą be jo būtų galima kurti tik Poisson (prastesnis) –
    # tada perskaičiuojama nuo gylio žemėlapių
    after = names[names.index("dense") + 1:] if "dense" in names else []
    if (start in after and os.path.exists(os.path.join(root, "work", "dense", ".openmvs"))
            and not os.path.isfile(os.path.join(root, "work", "openmvs", "dense.mvs"))):
        print("OpenMVS scenos nebėra (ištrinta po tekstūros) – perskaičiuojama nuo „dense“", flush=True)
        start = "dense"
    for s in names[names.index(start):]:
        p = os.path.join(root, "work", ".done_" + s)
        if os.path.exists(p):
            os.remove(p)
    print("Perskaičiuojama nuo „%s“, režimas %s, OpenMVS įrenginys %s" % (
        start, quality, pipeline.OPENMVS_DEVICE + (" (GPU)" if pipeline.OPENMVS_DEVICE != "-2" else " (procesorius)")), flush=True)
    pipeline.Pipeline(root, quality).run()


if __name__ == "__main__":
    main(*sys.argv[1:3])
