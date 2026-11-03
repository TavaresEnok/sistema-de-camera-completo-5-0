const {createRequire}=require('node:module');
const esbuild = createRequire(require.resolve('vite'))('esbuild');
esbuild.build({
  entryPoints:['/app/apps/web/tests/browser/desktop-notices-fixture.tsx'],
  bundle:true,format:'iife',outfile:'/output/desktop-fixture.js',
  alias:{'@':'/app/apps/web/src'},
  define:{'import.meta.env':'{}','process.env.NODE_ENV':'"production"'},
  plugins:[{name:'isolated-live-player',setup(build){
    build.onResolve({filter:/\/LiveStreamPlayer$/},()=>({path:'fixture-player',namespace:'fixture'}));
    build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`import React from 'react'; export function LiveStreamPlayer({cameraId,cameraName}) {return React.createElement('div',{'data-testid':'fixture-video','data-camera-id':cameraId},cameraName);}`,resolveDir:'/app/apps/web'}));
  }}],
}).catch(error=>{console.error(error);process.exit(1);});
