import { useEffect, useState } from 'react';
import axios from 'axios';
import { getApiBaseUrl } from '../lib/api-base';

export function usePasswordPolicy(token: string | null) {
  const [strong, setStrong] = useState<boolean | null>(null);
  useEffect(() => {
    setStrong(null);
    if (!token) return;
    const controller = new AbortController();
    void axios.get(`${getApiBaseUrl()}/settings`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal, timeout: 15000 })
      .then(({ data }) => setStrong(data.requireStrongPassword === true)).catch(() => {});
    return () => controller.abort();
  }, [token]);
  return {
    hint: strong === true ? 'Pelo menos 12 caracteres, com maiúscula, minúscula e número.' : strong === false ? 'Pelo menos 4 caracteres.' : 'Use uma senha longa com maiúscula, minúscula e número.',
    validate: (password: string) => password.length < 4 ? 'Use pelo menos 4 caracteres.' : strong === true && !(password.length >= 12 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password)) ? 'Use pelo menos 12 caracteres, com maiúscula, minúscula e número.' : null,
  };
}
