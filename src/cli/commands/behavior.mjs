import {loadBehavior,BEHAVIOR_IDS} from '../../core/behavior.mjs'
try{
 const [action='list',id]=process.argv.slice(2)
 if(action==='read')console.log(loadBehavior([id])[0].text)
 else if(action==='list')console.log(JSON.stringify({sections:BEHAVIOR_IDS}))
 else throw Error('用法：behavior list | read <章节>')
}catch(e){console.error(e.message);process.exitCode=1}
