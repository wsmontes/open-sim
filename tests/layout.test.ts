import {expect,test} from 'vitest';
import {TARGET_POINTER,TARGET_TOUCH,layoutFor,targetSize} from '../src/presentation/layout';
import type {LayoutMode} from '../src/presentation/layout';

// The shell arranges itself by the area it has and by whether the pointer is a finger. A device name would be a lie the
// browser refuses to tell anyway: the same phone is portrait, landscape and half of a split screen within a minute, and
// a small window on a large monitor is the same problem as a tablet.
test('every screen in the matrix gets the arrangement its area calls for',()=>{
 const screens:Array<{name:string;w:number;h:number;touch:boolean;want:Partial<LayoutMode>}>= [
  {name:'telefone em pé',w:390,h:844,touch:true,want:{dock:'bottom',sheets:'sheet',inspector:'card',floating:false,touch:true}},
  {name:'telefone deitado',w:844,h:390,touch:true,want:{dock:'bottom',sheets:'sheet',floating:false,touch:true}},
  {name:'telefone em Split View',w:380,h:700,touch:true,want:{sheets:'sheet',floating:false}},
  {name:'tablet em pé',w:768,h:1024,touch:true,want:{sheets:'sheet',floating:false,touch:true}},
  {name:'tablet deitado',w:1024,h:768,touch:true,want:{sheets:'drawer',inspector:'panel',floating:false}},
  {name:'notebook',w:1366,h:768,touch:false,want:{dock:'bottom',sheets:'drawer',inspector:'panel',floating:true}},
  {name:'tela grande',w:1920,h:1080,touch:false,want:{sheets:'drawer',floating:true}},
  {name:'ultrawide',w:2560,h:1080,touch:false,want:{dock:'rail',sheets:'drawer',floating:true}},
 // A small window on a large monitor is not a tablet and not a desktop: the city keeps most of the width and no
 // screen floats, which is the part that matters about it.
  {name:'janela pequena num monitor grande',w:900,h:700,touch:false,want:{dock:'bottom',sheets:'drawer',floating:false}},
 ];
 for(const screen of screens)expect(layoutFor(screen.w,screen.h,screen.touch),screen.name).toMatchObject(screen.want);
});

test('a finger always gets a fingertip, and nothing floats where it cannot be reached',()=>{
 for(const [w,h] of [[320,480],[390,844],[844,390],[768,1024],[1024,768],[1366,768],[1920,1080],[2560,1080]] as const){
  const finger=layoutFor(w,h,true),mouse=layoutFor(w,h,false);
  expect(targetSize(finger),`${w}x${h}`).toBe(TARGET_TOUCH);
  expect(targetSize(mouse),`${w}x${h}`).toBe(TARGET_POINTER);
  // The guideline's floor is 24 CSS pixels; a fingertip wants more, and neither may go under.
  expect(TARGET_TOUCH).toBeGreaterThanOrEqual(44);
  expect(TARGET_POINTER).toBeGreaterThanOrEqual(24);
  // A screen with a finger in it never keeps a window the player can drag out of reach.
  expect(finger.floating,`${w}x${h}`).toBe(false);
 }
});
