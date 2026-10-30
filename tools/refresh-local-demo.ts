import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { DOCUMENT_PRESETS, fieldsToStorage } from '../src/server/services/documents';
import { newId } from '../src/lib/id';
async function main(){
 const url=new URL(process.env.DATABASE_URL || '');
 if(process.env.APP_ENV!=='local' || url.hostname!=='127.0.0.1' || url.port!=='5463')throw new Error('기브싸인 로컬 미리보기 DB에서만 실행할 수 있습니다.');
 const db=new PrismaClient({adapter:new PrismaPg({connectionString:url.toString(),max:1})});
 try {
 for(const [email,code,before,after] of [['merchant1@givesign.kr','GIV-8K2M','05051001001','158812341234'],['merchant2@givesign.kr','GIV-3QP7','05059000000','158812345678']]){
  const org=await db.merchantProfile.findFirst({where:{code,user:{email}}});if(!org)continue;
  await db.merchantMoNumber.updateMany({where:{merchantId:org.id,phoneNumber:before},data:{phoneNumber:after}});
  for(const key of ['SUPPORT_AGREEMENT','VOLUNTEER_APPLICATION','PROGRAM_APPLICATION','GOODS_DONATION','CONSENT_PRIVACY']){
   const p=DOCUMENT_PRESETS.find(x=>x.key===key)!;
   if(!await db.documentTemplate.findFirst({where:{merchantId:org.id,presetKey:key}}))await db.documentTemplate.create({data:{id:newId(),merchantId:org.id,templateType:'PRESET',presetKey:key,name:p.name,description:p.description,body:p.body,fields:fieldsToStorage(p.fields),requireSignature:p.requireSignature}});
  }
 }
 console.log('Local seed MO numbers and welfare document templates prepared.');
 }finally{await db.$disconnect();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
