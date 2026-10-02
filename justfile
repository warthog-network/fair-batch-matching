set shell := ["bash", "-uc"]

default: build

build: configure compile stage

configure:
    meson setup build-wasm --cross-file=crosscompile/emscripten.txt --prefix=/

compile:
    meson compile -C build-wasm

stage:
    DESTDIR="$(pwd)/out" meson install -C build-wasm

dev: configure compile
    (cd demo && python3 server.py)

run: build
    (cd out && python3 server.py)

reconfigure:
    meson setup build-wasm --cross-file=crosscompile/emscripten.txt --reconfigure --prefix=/

clean:
    rm -rf build-wasm out

# Build the npm package: wasm → tsc → assets. Mirrors CI step 10.
build-pkg:
    cd pkg && npm install --no-audit --no-fund && npm run build

# Remove pkg/dist/ and pkg/node_modules/. The wasm build dir and demo out/
# are not touched — use `just clean` for those.
clean-pkg:
    cd pkg && rm -rf dist node_modules

# Bump version in meson.build AND pkg/package.json in lockstep, commit,
# and tag locally. Push yourself.
bump part="patch":
    #!/usr/bin/env bash
    set -euo pipefail
    cur=$(grep -oP "^\s*version\s*:\s*'\K[^']+" meson.build)
    IFS='.' read -r -a parts <<< "$cur"
    major="${parts[0]:-0}"; minor="${parts[1]:-0}"; patch="${parts[2]:-0}"
    case "{{part}}" in
      major) major=$((major + 1)); minor=0; patch=0 ;;
      minor) minor=$((minor + 1)); patch=0 ;;
      patch) patch=$((patch + 1)) ;;
      *) echo "usage: just bump [major|minor|patch]" >&2; exit 1 ;;
    esac
    new="${major}.${minor}.${patch}"
    sed -i -E "s/(version\s*:\s*')$cur'/\1${new}'/" meson.build
    sed -i -E "s/(\"version\"\s*:\s*\")[^\"]+(\")/\1${new}\2/" pkg/package.json
    git add meson.build pkg/package.json
    git commit -m "bump version to ${new}"
    git tag -a "v${new}" -m "Release v${new}"
    echo "Committed and tagged v${new}. Push with:"
    echo "    git push origin master --follow-tags"

# Tag HEAD at the existing version (re-tag after a fixup). Push yourself.
# Also re-syncs pkg/package.json if it ever drifts from meson.build.
release:
    #!/usr/bin/env bash
    set -euo pipefail
    v=$(grep -oP "^\s*version\s*:\s*'\K[^']+" meson.build)
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
