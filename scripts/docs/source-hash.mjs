import {createHash} from 'node:crypto';
// Git normalizes these text files to LF. Preserve content while accepting CRLF checkouts.
export function sourceTextHash(source) {
  return createHash('sha256').update(source.toString('utf8').replace(/\r\n/g,'\n'),'utf8').digest('hex');
}
