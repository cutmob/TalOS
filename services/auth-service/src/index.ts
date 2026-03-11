export interface User {
  id: string;
  email: string;
  role: 'admin' | 'operator' | 'viewer';
  permissions: Permission[];
}

export type Permission =
  | 'execute:*'
  | 'execute:jira'
  | 'execute:slack'
  | 'execute:gmail'
  | 'execute:hubspot'
  | 'execute:notion'
  | 'admin:workflows'
  | 'admin:agents'
  | 'view:dashboard';

export interface SafetyGate {
  action: string;
  requiresConfirmation: boolean;
  requiredPermission: Permission;
  description: string;
}

/**
 * Auth & Safety Service — enforces permissions and safety gates.
 *
 * Enterprise automation requires:
 * - Role-based access control
 * - Approval gates for sensitive actions
 * - Audit logging
 */
export class AuthService {
  private safetyGates: SafetyGate[] = [
    { action: 'delete', requiresConfirmation: true, requiredPermission: 'execute:*', description: 'Delete operations require confirmation' },
    { action: 'send_bulk_email', requiresConfirmation: true, requiredPermission: 'execute:gmail', description: 'Bulk email requires confirmation' },
    { action: 'financial_transaction', requiresConfirmation: true, requiredPermission: 'execute:*', description: 'Financial operations require confirmation' },
  ];

  checkPermission(user: User, permission: Permission): boolean {
    if (user.role === 'admin') return true;
    return user.permissions.includes(permission) || user.permissions.includes('execute:*');
  }

  requiresConfirmation(action: string): SafetyGate | null {
    return this.safetyGates.find((g) => action.includes(g.action)) ?? null;
  }

  createAuditEntry(userId: string, action: string, result: 'allowed' | 'denied' | 'confirmed'): void {
    // In production: write to audit log (DynamoDB / CloudWatch)
    console.log(`[AUDIT] user=${userId} action=${action} result=${result} time=${new Date().toISOString()}`);
  }
}
