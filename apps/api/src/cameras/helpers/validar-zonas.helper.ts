import { BadRequestException } from '@nestjs/common';

type Ponto = [number, number];

function orientacao(a: Ponto, b: Ponto, c: Ponto) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentosSeCruzam(a: Ponto, b: Ponto, c: Ponto, d: Ponto) {
  const o1 = orientacao(a, b, c);
  const o2 = orientacao(a, b, d);
  const o3 = orientacao(c, d, a);
  const o4 = orientacao(c, d, b);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0))
    && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}

function validarPoligono(nome: string, pontos: Ponto[]) {
  const chaves = pontos.map(([x, y]) => `${x}:${y}`);
  if (new Set(chaves).size !== pontos.length) {
    throw new BadRequestException(`A área "${nome}" possui pontos repetidos.`);
  }
  const areaDobrada = Math.abs(pontos.reduce((soma, ponto, indice) => {
    const proximo = pontos[(indice + 1) % pontos.length];
    return soma + ponto[0] * proximo[1] - proximo[0] * ponto[1];
  }, 0));
  if (areaDobrada < 0.00002) {
    throw new BadRequestException(`A área "${nome}" é pequena demais ou não possui interior.`);
  }
  for (let i = 0; i < pontos.length; i += 1) {
    const a = pontos[i]; const b = pontos[(i + 1) % pontos.length];
    for (let j = i + 1; j < pontos.length; j += 1) {
      if (j === i || j === i + 1 || (i === 0 && j === pontos.length - 1)) continue;
      const c = pontos[j]; const d = pontos[(j + 1) % pontos.length];
      if (segmentosSeCruzam(a, b, c, d)) {
        throw new BadRequestException(`A área "${nome}" cruza sobre ela mesma.`);
      }
    }
  }
}

/**
 * Validação das zonas por TIPO — o que o DTO sozinho não consegue exigir.
 *
 * O DTO valida a lista inteira com uma regra só (2 a 40 pontos), porque
 * `class-validator` não sabe olhar o `kind` do mesmo objeto. Mas as duas formas
 * têm exigências opostas:
 *
 *   · polígono precisa de 3+ pontos — com 2 seria uma área de espessura zero:
 *     nada cai dentro, a zona nunca dispara, e o operador vê "zona salva" sobre
 *     algo que não faz nada;
 *   · linha precisa de EXATAMENTE 2 — com 3 não dá para dizer qual trecho é a
 *     travessia, e o sentido (a seta) perde significado.
 *
 * Recusar aqui, com mensagem clara, é melhor que aceitar e falhar em silêncio
 * na hora em que alguém pular o muro.
 */
export function validarZonasDeDeteccao(zonas: unknown): void {
  if (zonas === undefined || zonas === null) return;
  if (!Array.isArray(zonas)) {
    throw new BadRequestException('Zonas de detecção devem ser uma lista.');
  }

  for (const zona of zonas as any[]) {
    const nome = String(zona?.name ?? zona?.id ?? 'sem nome');
    const pontos = Array.isArray(zona?.points) ? zona.points : [];

    if (zona?.kind === 'line') {
      if (pontos.length !== 2) {
        throw new BadRequestException(
          `A linha "${nome}" precisa de exatamente 2 pontos (início e fim); recebeu ${pontos.length}.`,
        );
      }
      const [a, b] = pontos;
      const iguais = Number(a?.[0]) === Number(b?.[0]) && Number(a?.[1]) === Number(b?.[1]);
      if (iguais) {
        throw new BadRequestException(`A linha "${nome}" tem os dois pontos no mesmo lugar — não há travessia possível.`);
      }
    } else if (pontos.length < 3) {
      throw new BadRequestException(
        `A área "${nome}" precisa de pelo menos 3 pontos; com ${pontos.length} ela não tem interior e nunca dispararia.`,
      );
    }

    // Coordenadas normalizadas: fora de 0..1 significa que alguém enviou
    // pixels. A zona "funcionaria" no banco e não casaria com quadro nenhum.
    for (const par of pontos) {
      const x = Number(par?.[0]);
      const y = Number(par?.[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
        throw new BadRequestException(
          `"${nome}" tem ponto fora do quadro (${par?.[0]}, ${par?.[1]}). As coordenadas são normalizadas de 0 a 1.`,
        );
      }
    }
    if (zona?.kind !== 'line') {
      validarPoligono(nome, pontos.map((par: unknown[]) => [Number(par[0]), Number(par[1])] as Ponto));
    }
  }
}

/**
 * A lista contém zona de ÁREA (include/exclude)?
 *
 * Importa porque área exige o NOSSO detector: o gatilho nativo da câmera
 * (`motionTrigger='CAMERA'`, evento ONVIF) dispara para movimento em qualquer
 * ponto da cena e não carrega coordenadas — é incapaz de respeitar a máscara.
 * Linha de perímetro tem tratamento próprio (tripwire via modo objeto).
 */
export function temZonaDeArea(zonas: unknown): boolean {
  return Array.isArray(zonas)
    && zonas.some((z) => z?.kind === 'include' || z?.kind === 'exclude');
}
