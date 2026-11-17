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
    for s in names[names.index(start):]:
        p = os.path.join(root, "work", ".done_" + s)
        if os.path.exists(p):
            os.remove(p)
    print("Perskaičiuojama nuo „%s“, režimas %s, OpenMVS įrenginys %s" % (
        start, quality, pipeline.OPENMVS_DEVICE + (" (GPU)" if pipeline.OPENMVS_DEVICE != "-2" else " (procesorius)")), flush=True)
    pipeline.Pipeline(root, quality).run()


if __name__ == "__main__":
    main(*sys.argv[1:3])
