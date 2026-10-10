project('fbm-demo', 'cpp',
  version : '0.6.0',
  default_options : ['warning_level=3',
    'cpp_std=c++23',
    'buildtype=release'])

src = files(
  'src/defi/uint64/orderbook.cpp',
  'src/defi/uint64/matcher.cpp',
  'src/general/funds.cpp',
)

json = subproject('json')
json_dep = json.get_variable('nlohmann_json_multiple_headers')

if get_option('emscripten')
  # Map the absolute emsdk include path to a canonical /emsdk prefix so
  # that __FILE__ strings emitted into the wasm data section don't leak
  # the user's home directory.
  em_root = run_command('em-config', 'EMSCRIPTEN_ROOT', check: false).stdout().strip()
  macro_prefix_map = []
  if em_root != ''
    macro_prefix_map = ['-fmacro-prefix-map=' + em_root + '=/emsdk']
  endif

  # Files outside the C++ project tree (siblings of cpp/) are accessed
  # by the justfile's `stage` recipe, not by meson install rules.
  # This avoids cross-dir install_dir paths which don't resolve reliably.
  exe = executable('fbm', ['src/fbm_bindings.cpp', src],
    dependencies: json_dep,
    cpp_args:['-fexceptions', '-g0',
              '-msse', '-msimd128', '-pthread',
              '-Wno-limited-postlink-optimizations', '-fPIC', '-pthread']
            + macro_prefix_map,
    name_suffix: 'html',
    include_directories: ['src'],
    link_args: ['-sMODULARIZE', '-sEXPORT_ES6',
      '-sNO_DISABLE_EXCEPTION_CATCHING',
      '-sINITIAL_MEMORY=67108864', '-mwasm64',
      '-lembind',
      '--emit-tsd', meson.project_source_root() / '..' / 'pkg' / 'index.raw.d.ts',
      ],
    install: false
  )
endif
