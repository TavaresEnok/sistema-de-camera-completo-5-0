export const CSS_CREDIT = '/*! Feito por by Enok Tavares https://github.com/TavaresEnok/ */';

// Also covers split vendor/lazy CSS, without replacing third-party notices.
export function sourceCreditPlugin() {
  return {
    name: 's2cam-source-credit',
    apply: 'build',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        for (const asset of Object.values(bundle)) {
          if (asset.type !== 'asset' || !asset.fileName.endsWith('.css')) continue;
          const source = typeof asset.source === 'string'
            ? asset.source : Buffer.from(asset.source).toString('utf8');
          if (!source.startsWith(CSS_CREDIT)) asset.source = `${CSS_CREDIT}\n${source}`;
        }
      },
    },
  };
}

// New CSS filenames prevent an immutable pre-credit asset from being reused.
export function creditedAssetFileNames(asset) {
  const names = asset.names ?? [asset.name ?? ''];
  return names.some(name => name.endsWith('.css'))
    ? 'assets/[name]-[hash]-enok[extname]'
    : 'assets/[name]-[hash][extname]';
}
