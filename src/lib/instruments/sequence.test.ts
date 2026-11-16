import { describe, expect, it } from 'vitest';
import { Midi } from '@tonejs/midi';
import { writeMidi } from 'midi-file';
import { midiEvents, snapshotMidi } from './sequence';
import { notesToMidi, midiFileToNotes } from '../music/midi';
import { MemoryLibrary } from '../library/memoryLibrary';

describe('native MIDI event preparation', () => {
  it('preserves polyphony, channel 10, velocities, exact file timing and releases before retrigger', () => {
    const midi = new Midi(); midi.header.setTempo(90);
    const t = midi.addTrack(); t.channel = 9; t.instrument.number = 12;
    t.addNote({midi:36,time:0,duration:1,velocity:100/127});
    t.addNote({midi:38,time:0,duration:0.5,velocity:80/127});
    t.addNote({midi:36,time:1,duration:1,velocity:90/127});
    const events = midiEvents(midi.toArray());
    expect(events.filter(e => (e.bytes[0]&0xf0) === 0x90).map(e => ({...e,time:Math.round(e.time*1e5)/1e5}))).toEqual([
      {time:0,bytes:[0x99,36,100]}, {time:0,bytes:[0x99,38,80]}, {time:1,bytes:[0x99,36,90]},
    ]);
    expect(events.filter(e => Math.abs(e.time-1) < 1e-5).map(e=>e.bytes[0])).toEqual([0x89,0x99]);
    expect(events.at(-1)!.time).toBeCloseTo(2,5);
    expect(events.at(-1)!.bytes).toEqual([0x89,36,0]);
  });
  it('retains controller, program, pitch bend and tempo map data', () => {
    const bytes = new Uint8Array(writeMidi({ header:{ format:0,numTracks:1,ticksPerBeat:480 }, tracks:[[
      {deltaTime:0,type:'programChange',channel:4,programNumber:81},
      {deltaTime:0,type:'noteOn',channel:4,noteNumber:60,velocity:127},
      {deltaTime:240,type:'pitchBend',channel:4,value:4096},
      {deltaTime:240,type:'controller',channel:4,controllerType:64,value:127},
      {deltaTime:480,type:'noteOff',channel:4,noteNumber:60,velocity:0},
      {deltaTime:0,type:'endOfTrack'},
    ]] }));
    const events = midiEvents(bytes);
    expect(events).toContainEqual({time:0,bytes:[0xc4,81]});
    expect(events).toContainEqual({time:0.5,bytes:[0xb4,64,127]});
    const bend = events.find(e=>(e.bytes[0]&0xf0)===0xe0)!;
    expect(bend.time).toBeCloseTo(0.25,2);
    expect(bend.bytes[1] + (bend.bytes[2]<<7)).toBeCloseTo(12288,-1);
  });
  it('keeps source MIDI and note snapshots independent of later edits', async () => {
    const lib = new MemoryLibrary(); const book = await lib.createNotebook('Test');
    const created = await lib.create({mediaExtension:'wav',mediaMime:'audio/wav',captureBackend:'import',notebookId:book.id});
    await lib.writeFile(created.id,'media-chunk',new Uint8Array([1]));
    await lib.finalize({id:created.id,durationMs:2000,hasVideo:false,videoWidth:null,videoHeight:null});
    const notes = [{pitch:60,startTime:0.125,endTime:1.875,velocity:83,channel:4,track:0}];
    const bytes = notesToMidi(notes,{bpm:93});
    await lib.writeFile(created.id,'original-midi',bytes);
    await lib.saveTranscription({id:created.id,engine:'midi-import',engineVersion:'1',params:{},notes,summary:null});
    const detail = await lib.get(created.id);
    const snapshot = snapshotMidi(detail,await lib.originalMidi(created.id) ?? undefined);
    detail.transcription!.originalNotes[0].pitch = 70;
    expect(snapshot.snapshot.notes.map(({confidence, ...n}) => n)).toEqual(notes);
    expect(snapshot.midi).toEqual(bytes);
    expect(midiFileToNotes(snapshot.midi,true)[0].channel).toBe(4);
    await expect(lib.writeFile(created.id,'original-midi',new Uint8Array([2]))).rejects.toThrow('immutable');
  });
});
