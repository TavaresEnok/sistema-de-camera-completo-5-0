import { Redirect, useRoute, useSearch } from 'wouter';
import { useAuthStore } from '../store/authStore';
import { legacyCameraDestination } from '../lib/camera-edit';

export default function LegacyCameraRedirect() {
  const [, params] = useRoute('/cameras/:id');
  const search = useSearch();
  const canEdit = useAuthStore(s => s.user?.role === 'admin');
  return <Redirect replace to={legacyCameraDestination(params?.id ?? '', new URLSearchParams(search).get('tab'), canEdit)} />;
}
