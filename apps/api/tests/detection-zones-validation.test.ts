import test from 'node:test';
import assert from 'node:assert/strict';
import { validarZonasDeDeteccao } from '../src/cameras/helpers/validar-zonas.helper';

const zona = (points: number[][]) => ({ id: 'z1', name: 'Pátio', kind: 'include', points });

test('aceita polígono simples com área útil', () => {
  assert.doesNotThrow(() => validarZonasDeDeteccao([zona([[0.1, 0.1], [0.8, 0.1], [0.8, 0.8], [0.1, 0.8]])]));
});

test('recusa área colinear, ponto repetido e polígono auto-intersectado', () => {
  const invalidas = [
    zona([[0.1, 0.1], [0.2, 0.2], [0.3, 0.3]]),
    zona([[0.1, 0.1], [0.8, 0.1], [0.8, 0.1], [0.1, 0.8]]),
    zona([[0.1, 0.1], [0.8, 0.8], [0.1, 0.8], [0.8, 0.1]]),
  ];
  for (const invalida of invalidas) {
    assert.throws(() => validarZonasDeDeteccao([invalida]));
  }
});
