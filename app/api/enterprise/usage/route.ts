import { getErrorStatus } from "@/lib/auth";
import{NextResponse}from"next/server";
import{getOrganizationForUser,requireUser}from"@/lib/auth";
import{hasEnterprisePermission}from"@/lib/enterprise/rbac";
import{getUsage}from"@/lib/enterprise/repository";
export async function GET(request:Request){try{const{db,user}=await requireUser();const org=await getOrganizationForUser(db,user.id,new URL(request.url).searchParams.get("organizationId"));if(!org||!hasEnterprisePermission(org.role,"billing.read"))return NextResponse.json({error:"Usage access denied"},{status:403});return NextResponse.json(await getUsage(org.id));}catch(e){const status=getErrorStatus(e);return NextResponse.json({error:e instanceof Error?e.message:"Unknown error"},{status});}}