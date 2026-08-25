import zipfile, os

stage = "OpsPilot-0.1.0-portable"
out = "OpsPilot-0.1.0-portable.zip"
here = os.path.dirname(os.path.abspath(__file__))
os.chdir(os.path.join(here, "..", "dist-portable"))
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(stage):
        for f in files:
            p = os.path.join(root, f)
            z.write(p, os.path.relpath(p, "."))
print("written", out, os.path.getsize(out), "bytes")
