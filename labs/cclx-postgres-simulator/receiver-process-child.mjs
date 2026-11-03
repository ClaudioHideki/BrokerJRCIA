import {openLabReceiver} from './receiver.mjs';

// Separate lab process: no HTTP listener, production configuration or source data.
// The parent forwards only its isolated synthetic HTTP fixture through IPC.
if (!process.send || process.env.NODE_ENV === 'production') process.exit(2);
let receiver;
const methods = new Set(['handle','readEvent','readMediaReceipt','stats']);
process.on('disconnect', () => process.exit(1));
process.on('message', async message => {
 if (!message || !Number.isSafeInteger(message.id)) return;
 try {
  let value;
  if (message.method === 'initialize' && !receiver) {
   receiver = await openLabReceiver(message.options);
   value = {ready:true,pid:process.pid};
  } else if (message.method === 'close' && receiver) {
   await receiver.close();
   process.send({id:message.id,value:{closed:true}}, () => process.exit(0));
   return;
  } else if (receiver && methods.has(message.method)) {
   const argument = message.method === 'handle'
    ? {...message.argument,rawBody:Buffer.from(message.argument.rawBody)} : message.argument;
   value = await receiver[message.method](argument);
  } else throw Error('INVALID_LAB_OPERATION');
  process.send({id:message.id,value});
 } catch {
  // Never forward environment, credentials, URLs or remote error bodies via IPC logs.
  process.send({id:message.id,error:'LAB_RECEIVER_OPERATION_FAILED'});
 }
});
