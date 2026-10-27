set shell := ["bash", "-uc"]

default: build

build: configure compile build-pkg stage stage-pkg

configure:
    (cd cpp && meson setup build-wasm --cross-file=crosscompile/emscripten.txt --prefix=/)

compile:
    meson compile -C cpp/build-wasm

# Copy the demo sources into demo/out/ for the bundle. Meson install
# doesn't do this anymore (cross-dir install_dir paths don't resolve
# reliably); the justfile owns the staging.
stage:
    mkdir -p demo/out
    cp -f demo/src/demo.html demo/src/server.py demo/src/README.md LICENSE demo/out/

# Copy the runtime parts of pkg/dist/ into demo/out for the demo zip.
# .d.ts files stay in pkg/dist/ (they ship via the npm tarball instead,
# which is what TypeScript consumers need).
stage-pkg:
    mkdir -p demo/out/warthog-fbm/src
    cp -f pkg/dist/index.js pkg/dist/fbm.js pkg/dist/fbm.wasm demo/out/warthog-fbm/
    cp -f pkg/dist/src/loader.js demo/out/warthog-fbm/src/

# Dev: serve the demo source tree (live HTML/JS iteration) via a symlink
# that exposes pkg/dist/ as demo/src/warthog-fbm/. The symlink is
# gitignored and auto-created on first run.
dev: build-pkg ensure-dev-symlink
    (cd demo/src && python3 server.py)

ensure-dev-symlink:
    [ -L demo/src/warthog-fbm ] || ln -s ../../pkg/dist demo/src/warthog-fbm

run: build
    (cd demo/out && python3 server.py)

reconfigure:
    (cd cpp && meson setup build-wasm --cross-file=crosscompile/emscripten.txt --reconfigure --prefix=/)

clean:
    rm -rf cpp/build-wasm demo/out

# Build the npm package: wasm → tsc → assets. Mirrors CI step 10.
build-pkg:
    cd pkg && npm install --no-audit --no-fund && npm run build

# Remove pkg/dist/ and pkg/node_modules/. The wasm build dir and demo out/
# are not touched — use `just clean` for those.
clean-pkg:
    cd pkg && rm -rf dist node_modules

# Bump version in cpp/meson.build, pkg/package.json AND
# pkg/package-lock.json in lockstep, commit, and tag locally. Push yourself.
bump part="patch":
    #!/usr/bin/env bash
    set -euo pipefail
    cur=$(grep -oP "^\s*version\s*:\s*'\K[^']+" cpp/meson.build)
    IFS='.' read -r -a parts <<< "$cur"
    major="${parts[0]:-0}"; minor="${parts[1]:-0}"; patch="${parts[2]:-0}"
    case "{{part}}" in
      major) major=$((major + 1)); minor=0; patch=0 ;;
      minor) minor=$((minor + 1)); patch=0 ;;
      patch) patch=$((patch + 1)) ;;
      *) echo "usage: just bump [major|minor|patch]" >&2; exit 1 ;;
    esac
    new="${major}.${minor}.${patch}"
    sed -i -E "s/(version\s*:\s*')$cur'/\1${new}'/" cpp/meson.build
    sed -i -E "s/(\"version\"\s*:\s*\")[^\"]+(\")/\1${new}\2/" pkg/package.json
    # The lockfile carries the version twice: at the top level and in the
    # root package entry. Patch those two only, a blanket sed would hit the
    # dependencies' versions too.
    node -e '
      const fs = require("fs");
      const p = "pkg/package-lock.json";
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      j.version = process.argv[1];
      if (j.packages && j.packages[""]) j.packages[""].version = process.argv[1];
      fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
    ' "$new"
    git add cpp/meson.build pkg/package.json pkg/package-lock.json
    git commit -m "bump version to ${new}"
    git tag -a "v${new}" -m "Release v${new}"
    echo "Committed and tagged v${new}. Push with:"
    echo "    git push origin master --follow-tags"

# Tag HEAD at the existing version (re-tag after a fixup). Push yourself.
# Also re-syncs pkg/package.json if it ever drifts from meson.build.
release:
    #!/usr/bin/env bash
    set -euo pipefail
    v=$(grep -oP "^\s*version\s*:\s*'\K[^']+" cpp/meson.build)
    npm_v=$(node -p "require('./pkg/package.json').version")
    if [ "$v" != "$npm_v" ]; then
      echo "Syncing pkg/package.json: ${npm_v} -> ${v}"
      sed -i -E "s/(\"version\"\s*:\s*\")[^\"]+(\")/\1${v}\2/" pkg/package.json
      git add pkg/package.json
      git commit -m "sync pkg/package.json version to ${v}"
    fi
    tag="v${v}"
    git tag -a "$tag" -m "Release $tag"
    echo "Tagged $tag. Push with:"
    echo "    git push origin master --follow-tags"
