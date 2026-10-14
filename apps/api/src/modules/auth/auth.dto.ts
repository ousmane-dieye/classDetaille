export type AdminCodeRequiredDto = { status: 'ADMIN_CODE_REQUIRED'; expiresInSeconds: 600; resendAfterSeconds: 60 };

export const adminCodeRequiredDto = (s: { expiresInSeconds: 600; resendAfterSeconds: 60 }): AdminCodeRequiredDto =>
  ({ status: 'ADMIN_CODE_REQUIRED', expiresInSeconds: s.expiresInSeconds, resendAfterSeconds: s.resendAfterSeconds });
