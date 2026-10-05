import { HttpException, Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { type AuthUser } from '../common/types/auth-user.type';
import { decidirLicenca } from './helpers/vencimento-de-licenca.helper';
import { explicarTeto, podeCadastrarCamera } from './helpers/teto-de-cameras.helper';
import { deviceIdentity, trustedLicenseKeys, verifyLicense, licenseVerificationRequired, type LicenseDocument } from '../common/licensing/signed-license';

// `aiAdvanced` = OBJETO/FACE (pesadas). `aiMotion` = detecção de MOVIMENTO
// (MOG2), que arma a gravação por movimento e é tratada à parte de propósito:
// confundir as duas derrubava o MOG2 sempre que objeto/face estavam desligados,
// que é o estado normal e desejado.
// `aiObject` e `aiFace` são o desdobramento GRANULAR do antigo `aiAdvanced`.
// A Central já os enviava desde sempre; a instalação os DESCARTAVA em
// `parseRestrictions` (a lista de chaves conhecidas não os continha), então
// ligar "objeto" no painel mestre não tinha efeito nenhum aqui — só o
// legado `aiAdvanced`, que acende objeto e face juntos. `aiAdvanced` continua
// existindo como TETO dos dois, para não quebrar instalação antiga.
export type CommercialFeature = 'localLive' | 'localRecording' | 'localPlayback' | 'addCameras' | 'aiAdvanced' | 'aiMotion' | 'aiObject' | 'aiFace' | 'exports';
export type CommercialLicenseStatus = 'UNKNOWN' | 'ACTIVE' | 'GRACE' | 'RESTRICTED' | 'SUSPENDED';

type RestrictionMap = Record<CommercialFeature | 'adminAccess' | 'cloudSupport' | 'updates', boolean>;

const DEFAULT_RESTRICTIONS: RestrictionMap = {
  localLive: true,
  localRecording: true,
  localPlayback: true,
  addCameras: true,
  aiAdvanced: true,
  aiMotion: true,
  aiObject: true,
  aiFace: true,
  exports: true,
  adminAccess: true,
  cloudSupport: true,
  updates: true,
};

const STATUS_DEFAULTS: Record<CommercialLicenseStatus, RestrictionMap> = {
  UNKNOWN: DEFAULT_RESTRICTIONS,
  ACTIVE: DEFAULT_RESTRICTIONS,
  GRACE: DEFAULT_RESTRICTIONS,
  RESTRICTED: {
    ...DEFAULT_RESTRICTIONS,
    addCameras: false,
    aiAdvanced: false,
    updates: false,
  },
  SUSPENDED: {
    ...DEFAULT_RESTRICTIONS,
    localLive: false,
    localRecording: false,
    addCameras: false,
    aiAdvanced: false,
    aiMotion: false,
    aiObject: false,
    aiFace: false,
    cloudSupport: false,
    updates: false,
  },
};

const GENERIC_FEATURE_MESSAGES: Record<CommercialFeature, string> = {
  localLive: 'Transmissão temporariamente indisponível. Entre em contato com o administrador do sistema.',
  localRecording: 'Gravação temporariamente indisponível. Entre em contato com o administrador do sistema.',
  localPlayback: 'Playback temporariamente indisponível. Entre em contato com o administrador do sistema.',
  addCameras: 'Cadastro de novas câmeras temporariamente indisponível. Entre em contato com o administrador do sistema.',
  aiAdvanced: 'Análise inteligente temporariamente indisponível. Entre em contato com o administrador do sistema.',
  aiMotion: 'Detecção de movimento temporariamente indisponível. Entre em contato com o administrador do sistema.',
  aiObject: 'Detecção de objetos temporariamente indisponível. Entre em contato com o administrador do sistema.',
  aiFace: 'Reconhecimento facial temporariamente indisponível. Entre em contato com o administrador do sistema.',
  exports: 'Exportação temporariamente indisponível. Entre em contato com o administrador do sistema.',
};

@Injectable()
export class CommercialPolicyService {
  private signatureRequired = false;
  private verifiedDocument?: { token: string; installationId: string; document: LicenseDocument };
  constructor(private readonly prisma: PrismaService) {}

  async getPolicy() {
    const rows = await this.prisma.systemSetting.findMany({
      where: {
        key: {
          in: [
            'cloud.licenseStatus', 'cloud.licenseMessage', 'cloud.restrictions',
            'cloud.signedLicense', 'cloud.licenseVerificationRequired',
            'cloud.lastSyncAt', 'cloud.lastError',
            // Mitigates ordinary clock rollback, not a hostile root restoring
            // both database and clock from a snapshot.
            'cloud.maiorInstanteVisto',
            // Teto de câmeras contratado, definido na Central.
            'cloud.maxCameras',
            'cloud.maxUsers', 'cloud.maxRetentionDays',
          ],
        },
      },
    });
    const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    this.signatureRequired ||= licenseVerificationRequired(settings['cloud.signedLicense'], settings['cloud.licenseVerificationRequired']);
    const signedRequired = this.signatureRequired;
    const now = Math.max(Date.now(), this.paraMs(settings['cloud.maiorInstanteVisto']) || 0);
    let document: LicenseDocument | undefined;
    let verificationError: string | null = null;
    if (signedRequired) {
      try {
        const token = settings['cloud.signedLicense'];
        const installationId = process.env.CLOUD_INSTALLATION_ID || '';
        if (!installationId || !token) throw new Error('license_document_missing');
        if (this.verifiedDocument?.token === token && this.verifiedDocument.installationId === installationId) {
          document = this.verifiedDocument.document;
          const seconds = Math.floor(now / 1000);
          if (seconds < document.nbf || seconds >= document.exp) throw new Error('license_expired_or_not_yet_valid');
        } else {
          document = verifyLicense(token, { keys: trustedLicenseKeys(), installationId, device: deviceIdentity().fingerprint, now,
            previous: this.verifiedDocument?.document });
          this.verifiedDocument = { token, installationId, document };
        }
      } catch (error) {
        document = undefined;
        verificationError = error instanceof Error ? error.message : 'license_verification_failed';
      }
    }
    const statusDaCentral = signedRequired ? document?.status || 'SUSPENDED' : this.normalizeStatus(settings['cloud.licenseStatus']);
    const centralRestrictions = signedRequired ? document?.restrictions || {} : this.parseRestrictions(settings['cloud.restrictions']);

    // ── A LICENÇA VENCE SOZINHA ────────────────────────────────────────────
    //
    // Antes de 24/08/2026 a instalação só obedecia ao que a Central mandava. Sem
    // contato, nada mudava — e `UNKNOWN` (o estado de quem nunca falou) liberava
    // tudo. Bastava tirar a máquina da internet para rodar de graça, completo.
    //
    // Agora o silêncio corta sozinho: 10 dias restringe, 15 suspende. Vale o
    // estado MAIS SEVERO entre o que a Central disse e o que o silêncio impõe.
    const decisao = decidirLicenca({
      estadoDaCentral: statusDaCentral,
      ultimoContatoMs: signedRequired ? (document ? document.iat * 1000 : null) : this.paraMs(settings['cloud.lastSyncAt']),
      agoraMs: now,
      maiorInstanteVistoMs: this.paraMs(settings['cloud.maiorInstanteVisto']),
    });
    const licenseStatus = decisao.estado;

    const mergedRestrictions: RestrictionMap = {
      ...DEFAULT_RESTRICTIONS,
      ...centralRestrictions,
      ...this.statusCaps(licenseStatus),
    };
    if (document && now >= document.restrictAt * 1000) {
      Object.assign(mergedRestrictions, this.statusCaps('RESTRICTED'));
    }

    return {
      licenseStatus,
      /** Estado que a Central mandou, antes do vencimento por silêncio. */
      statusDaCentral,
      /** Dias sem falar com a Central, para o painel explicar o que houve. */
      diasSemContato: decisao.diasSemContato,
      diasAteOProximoCorte: decisao.diasAteOProximoCorte,
      avisarSobreContato: decisao.avisar,
      motivoDaLicenca: decisao.motivo,
      /** Teto de câmeras contratado. null = sem teto definido pela Central. */
      maxCameras: signedRequired ? document?.limits.cameras ?? null : this.paraInteiro(settings['cloud.maxCameras']),
      maxUsers: signedRequired ? document?.limits.users ?? null : this.paraInteiro(settings['cloud.maxUsers']),
      maxRetentionDays: signedRequired ? document?.limits.retentionDays ?? null : this.paraInteiro(settings['cloud.maxRetentionDays']),
      licenseVerification: signedRequired ? verificationError ? 'invalid' : 'verified' : 'legacy',
      licenseVerificationError: verificationError,
      securityProfile: 'standard',
      hardwareProtected: false,
      licenseMessage: settings['cloud.licenseMessage'] || null,
      lastSyncAt: settings['cloud.lastSyncAt'] || null,
      lastError: settings['cloud.lastError'] || null,
      restrictions: mergedRestrictions,
      // Fora de `restrictions` de propósito: aquele mapa é de BOOLEANOS, e o
      // filtro que o protege (`parseRestrictions`) descartaria uma lista.
      // Estas são as classes de objeto que a Central liberou — o "o quê" da
      // detecção, complementando o "se" que vive em `aiObject`.
      aiObjectClasses: mergedRestrictions.aiObject === false
        ? []
        : signedRequired ? document?.objectClasses || [] : this.parseObjectClasses(settings['cloud.restrictions']),
    };
  }

  /**
   * Classes de objeto liberadas pela Central.
   *
   * Lista ausente/ilegível devolve VAZIO, nunca um catálogo padrão: passar a
   * detectar tudo justamente quando a permissão não chegou seria o pior erro
   * possível aqui — ampliaria sozinho o escopo do que foi vendido.
   */
  private parseObjectClasses(value: string | undefined): string[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      const bruto = parsed?.aiObjectClasses;
      if (!Array.isArray(bruto)) return [];
      return [...new Set(bruto.map((c: unknown) => String(c ?? '').trim().toLowerCase()).filter(Boolean))];
    } catch {
      return [];
    }
  }

  async isAllowed(feature: CommercialFeature) {
    const policy = await this.getPolicy();
    return policy.restrictions[feature] !== false;
  }

  async assertFeature(feature: CommercialFeature, user?: AuthUser) {
    const policy = await this.getPolicy();
    if (policy.restrictions[feature] !== false) return policy;

    const adminMessage = this.buildAdminMessage(feature, policy.licenseStatus, policy.licenseMessage);
    const userMessage =
      user?.role === UserRole.ADMIN || user?.role === UserRole.SUPER_ADMIN ? adminMessage : GENERIC_FEATURE_MESSAGES[feature];

    throw new HttpException(
      {
        error: 'commercial_restriction',
        code: `commercial_${feature}_restricted`,
        feature,
        licenseStatus: policy.licenseStatus,
        userMessage,
        adminMessage,
      },
      423,
    );
  }

  /** ISO → milissegundos. Vazio ou ilegível vira null (= nunca falou). */
  private paraMs(valor: string | undefined): number | null {
    if (!valor) return null;
    const t = Date.parse(valor);
    return Number.isFinite(t) ? t : null;
  }

  /** Texto → inteiro não negativo. Ausente ou ilegível vira null (= sem teto). */
  private paraInteiro(valor: string | undefined): number | null {
    if (valor === undefined || valor === null || String(valor).trim() === '') return null;
    const n = Number(valor);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  }

  /**
   * O teto de câmeras do contrato foi atingido?
   *
   * Fica AQUI, e não no serviço de câmeras, porque é regra comercial: quem
   * decide o número é a Central. Lança 423 (o mesmo código das demais
   * restrições comerciais) para o painel tratar de um jeito só.
   *
   * A contagem é do TOTAL cadastrado, incluindo as desativadas — desativar
   * câmera é um clique e seria um jeito trivial de furar o contrato.
   */
  async assertCameraQuota(quantidade = 1, user?: AuthUser) {
    const policy = await this.getPolicy();
    const cadastradas = await this.prisma.camera.count();
    const decisao = podeCadastrarCamera(cadastradas, policy.maxCameras, quantidade);
    if (decisao.permitido) return policy;

    const adminMessage = explicarTeto(decisao, policy.maxCameras);
    throw new HttpException(
      {
        error: 'commercial_restriction',
        code: 'commercial_camera_quota_exceeded',
        feature: 'addCameras',
        licenseStatus: policy.licenseStatus,
        maxCameras: policy.maxCameras,
        cadastradas,
        userMessage: 'Não é possível cadastrar mais câmeras nesta instalação. Fale com o administrador.',
        adminMessage,
      },
      423,
    );
  }

  async assertUserQuota(quantidade = 1) {
    const policy = await this.getPolicy();
    if (policy.maxUsers === null) return policy;
    const activeUsers = await this.prisma.user.count({ where: { isActive: true } });
    if (activeUsers + quantidade <= policy.maxUsers) return policy;
    throw new HttpException({
      error: 'commercial_restriction', code: 'commercial_user_quota_exceeded', feature: 'users',
      maxUsers: policy.maxUsers, activeUsers,
      userMessage: 'O limite de usuários ativos desta licença foi atingido.',
      adminMessage: `A licença permite ${policy.maxUsers} usuário(s) ativo(s); existem ${activeUsers}.`,
    }, 423);
  }

  async assertRetentionQuota(retentionDays?: number | null) {
    if (retentionDays === undefined || retentionDays === null) return;
    const policy = await this.getPolicy();
    if (policy.maxRetentionDays === null || retentionDays <= policy.maxRetentionDays) return policy;
    throw new HttpException({
      error: 'commercial_restriction', code: 'commercial_retention_quota_exceeded', feature: 'retention',
      maxRetentionDays: policy.maxRetentionDays,
      userMessage: `A licença permite retenção de até ${policy.maxRetentionDays} dias.`,
      adminMessage: `Retenção solicitada (${retentionDays} dias) excede o contrato (${policy.maxRetentionDays} dias).`,
    }, 423);
  }

  private normalizeStatus(value: string | undefined): CommercialLicenseStatus {
    if (value === 'ACTIVE' || value === 'GRACE' || value === 'RESTRICTED' || value === 'SUSPENDED') return value;
    return 'UNKNOWN';
  }

  private parseRestrictions(value: string | undefined): Partial<RestrictionMap> {
    if (!value) return {};
    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object') return {};
      const allowedKeys = new Set(Object.keys(DEFAULT_RESTRICTIONS));
      return Object.fromEntries(
        Object.entries(parsed).filter(([key, restriction]) => allowedKeys.has(key) && typeof restriction === 'boolean'),
      ) as Partial<RestrictionMap>;
    } catch {
      return {};
    }
  }

  private statusCaps(status: CommercialLicenseStatus): Partial<RestrictionMap> {
    // A status is a ceiling: its `true` defaults must not overwrite a feature
    // explicitly disabled by the signed contract.
    if (status === 'SUSPENDED' || status === 'RESTRICTED') {
      return Object.fromEntries(Object.entries(STATUS_DEFAULTS[status]).filter(([, allowed]) => !allowed));
    }
    return {};
  }

  private buildAdminMessage(feature: CommercialFeature, status: CommercialLicenseStatus, licenseMessage: string | null) {
    if (status === 'SUSPENDED') {
      return licenseMessage || `Instalação suspensa. O recurso ${feature} está temporariamente bloqueado pela política comercial.`;
    }
    if (status === 'RESTRICTED') {
      return licenseMessage || `Instalação em modo restrito. O recurso ${feature} está temporariamente bloqueado.`;
    }
    return licenseMessage || GENERIC_FEATURE_MESSAGES[feature];
  }
}
