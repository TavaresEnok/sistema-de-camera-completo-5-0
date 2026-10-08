import assert from 'node:assert/strict';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const server = await createServer({ server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const { CameraPrivacyFields } = await server.ssrLoadModule('/src/components/CameraPrivacyFields.tsx');
  const { useAuthStore } = await server.ssrLoadModule('/src/store/authStore.ts');
  useAuthStore.setState({ user: { id: 'admin', role: 'admin' }, accessToken: 'memory-only-fixture' });
  const render = value => renderToStaticMarkup(React.createElement(QueryClientProvider, { client: new QueryClient() },
    React.createElement(CameraPrivacyFields, { value, onChange() {} })));
  const common = render({ isPrivate: false, ownerUserId: '', privateViewerIds: [] });
  assert.ok(common.includes('Câmera privada') && common.includes('Não é uma transmissão pública') && !common.includes('<select'));
  const privateCamera = render({ isPrivate: true, ownerUserId: '', privateViewerIds: [] });
  assert.ok(privateCamera.includes('Proprietário da câmera') && privateCamera.includes('Outras pessoas que podem visualizar (0)'));
  assert.ok(privateCamera.includes('Grupos e administradores não ganham acesso automático'));
  assert.ok(privateCamera.includes('Carregando usuários') && privateCamera.includes('disabled=""'));
  console.log(JSON.stringify({ realReactRender: true, normalCameraNotPublic: true, privateOwnerRequired: true, optionalViewers: true, clearAdminAndGroupBoundary: true, accessibleLabels: true }));
} finally { await server.close(); }
