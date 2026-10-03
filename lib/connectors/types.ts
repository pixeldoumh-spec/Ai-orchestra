export type ConnectorStatus="active"|"degraded"|"disabled";
export type ConnectorAuthScheme="none"|"bearer"|"api_key"|"hmac";
export interface ConnectorDefinition{id:string;organizationId:string;name:string;kind:"reserved"|"http";baseUrl:string|null;status:ConnectorStatus;authScheme:ConnectorAuthScheme;version:string;circuitState:"closed"|"open";consecutiveFailures:number;failureThreshold:number;cooldownSeconds:number;cooldownUntil:string|null;fallbackConnectorId:string|null;lastSuccessAt:string|null;lastFailureAt:string|null;}
export interface AgentConnectorBinding{id:string;organizationId:string;agentId:string;connectorId:string;credentialId:string|null;allowedTools:string[];scopes:string[];priority:number;status:"active"|"revoked";}
export interface ConnectorCredentialMetadata{id:string;connectorId:string;organizationId:string;name:string;scopes:string[];authScheme:ConnectorAuthScheme;status:"active"|"revoked"|"expired";keyVersion:number;expiresAt:string|null;}
