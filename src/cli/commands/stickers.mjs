/**
 * CLI 命令 `stickers`：列出或查询内置表情包清单与本地文件路径。
 */
import {listStickers,getSticker} from '../../core/stickers.mjs'
try{const [action='list',value]=process.argv.slice(2);if(action==='list')console.log(JSON.stringify(listStickers({offset:value===undefined?0:Number(value)})));else if(action==='get')console.log(JSON.stringify(getSticker(value)));else throw Error('用法：stickers list [offset] | get <ID或情绪名>')}catch(e){console.error(e.message);process.exitCode=1}
