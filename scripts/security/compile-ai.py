"""Build our modules as native extensions, never include tests/generated C.

This raises the cost of copying; it is not confidential computing and cannot
prevent a privileged owner from reverse engineering a running process.
"""
from pathlib import Path
from setuptools import Extension, setup
from Cython.Build import cythonize

root = Path('/source')
files = sorted(root.glob('*.py')) + sorted((root / 'detectors').glob('*.py')) + sorted((root / 'trackers').glob('*.py'))
extensions = []
for filename in files:
    module = '.'.join(filename.relative_to(root).with_suffix('').parts)
    extensions.append(Extension(module, [str(filename)]))
setup(
    name='drac-ai-native',
    ext_modules=cythonize(
        extensions,
        compiler_directives={
            'language_level': 3, 'annotation_typing': False,
            'binding': True, 'infer_types': False,
        },
        build_dir='/build/cython',
    ),
    script_args=['build_ext', '--build-temp', '/build/objects', '--build-lib', '/native', '-j', '2'],
)
