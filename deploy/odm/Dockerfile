# Atea 3D Matuoklis – NodeODM su tikslesniu 3D tinklu (--mesh-method openmvs, žr. atea_mesh.py).
# Pagrindas – oficialus OpenDroneMap atvaizdas; pakeičiamas tik 3D tinklo etapas (patch.py). Jei naujoje ODM
# versijoje pakeitimo vietos pasikeitė – atvaizdas vis tiek sukuriamas, tik be naujos parinkties (Poisson).
ARG NODEODM_IMAGE=opendronemap/nodeodm:latest
FROM ${NODEODM_IMAGE}
COPY atea_mesh.py /code/opendm/atea_mesh.py
COPY patch.py /tmp/atea_patch.py
# ODM Python: naujose versijose – pixi aplinkoje, senesnėse – sisteminis. Laikinas failas paliekamas, jei jo
# ištrinti neleidžiama (GPU atvaizdas veikia ne kaip root), o „true“ gale – kad atvaizdo kūrimas niekada nenutrūktų.
RUN for py in /code/.pixi/envs/prod/bin/python3 /code/venv/bin/python3 /usr/bin/python3; do \
      if [ -x "$py" ]; then "$py" /tmp/atea_patch.py /code; break; fi; \
    done; rm -f /tmp/atea_patch.py 2>/dev/null; true
