// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryLibrary } from '../library/memoryLibrary';
import { encodeWav16 } from '../audio/wav';
import type { MidiSession } from './types';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), probe: vi.fn(), decode: vi.fn() }));
vi.mock('../platform/tauri', () => ({ invoke: mocks.invoke, fileUrl: (p:string)=>p, isTauri:()=>true }));
vi.mock('../audio/analysisAudio', () => ({ decodeMediaToAnalysisWav: mocks.decode }));
vi.mock('../library/importTrack', async importOriginal => ({ ...await importOriginal<typeof import('../library/importTrack')>(), probeMedia: mocks.probe }));
import { importSessionAudio } from './sessions';
const notes = [{pitch:60,startTime:0.125,endTime:1.875,velocity:83,channel:3,track:0}];
const session: MidiSession = {id:'session',sourceId:'source',sourceTitle:'Original',snapshot:{notes,tempoBpm:90,metadata:{}},midiHash:'abc',destination:{name:'MIDI'},createdAt:1,status:'pending',resultId:null,importId:null};

describe('returned audio orchestration', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.probe.mockResolvedValue({durationMs:2500,hasVideo:false,width:null,height:null}); mocks.decode.mockResolvedValue({durationMs:2500,wav:encodeWav16([new Float32Array(128)],22050)}); });
  it('copies original audio, uses the chosen immutable notes, and never requests transcription', async () => {
    const library = new MemoryLibrary(); const book = await library.createNotebook('Book');
    let id = '';
    mocks.invoke.mockImplementation(async (command, {args}: {args:Record<string,unknown>}) => {
      if (command === 'begin_midi_import') {
        const created = await library.create({mediaExtension:String(args.mediaExtension),mediaMime:String(args.mediaMime),captureBackend:'midi-round-trip',notebookId:book.id}); id=created.id; return created;
      }
      if (command === 'complete_midi_import') {
        expect(args.sessionId).toBe(session.id);
        await library.saveTranscription({id,engine:'midi-round-trip',engineVersion:'1',params:{},notes:session.snapshot.notes,summary:null});
        await library.finalize({id,durationMs:Number(args.durationMs),hasVideo:false,videoWidth:null,videoHeight:null}); return library.get(id);
      }
      throw new Error('Unexpected command '+command);
    });
    const original = new Uint8Array([0x49,0x44,0x33,1,2,3]);
    const file = new File([original], 'Analog.mp3', {type:'audio/mpeg'});
    const detail = await importSessionAudio(library,session,file,{notebookId:book.id,canvasXMs:0,canvasY:40});
    expect(detail.transcription!.originalNotes).toEqual(notes);
    expect(detail.transcriptionStatus).toBe('done');
    const { resolveObjectURL } = await import('node:buffer');
    expect(new Uint8Array(await resolveObjectURL(detail.mediaPath!)!.arrayBuffer())).toEqual(original);
    expect(mocks.invoke.mock.calls.map(c=>c[0])).toEqual(['begin_midi_import','complete_midi_import']);
  });
  it('aborts its reservation if decoding fails and keeps the session retryable', async () => {
    const library = new MemoryLibrary(); const book = await library.createNotebook('Book');
    mocks.invoke.mockImplementation(async command => command === 'begin_midi_import' ? {id:'reservation',mediaPath:'audio',analysisPath:'analysis'} : undefined);
    vi.spyOn(library,'writeFile').mockResolvedValue('audio');
    mocks.decode.mockRejectedValue(new Error('bad media'));
    await expect(importSessionAudio(library,session,new File([new Uint8Array([1])],'x.wav'),{notebookId:book.id,canvasXMs:0,canvasY:0})).rejects.toThrow('bad media');
    expect(mocks.invoke).toHaveBeenLastCalledWith('abort_midi_import',{id:session.id});
    expect(mocks.invoke.mock.calls.some(c=>c[0]==='complete_midi_import')).toBe(false);
  });
  it('rejects empty, excessive, unsupported and undecodable audio before reserving', async () => {
    const library = new MemoryLibrary(), place={notebookId:'b',canvasXMs:0,canvasY:0};
    await expect(importSessionAudio(library,session,new File([],'x.wav'),place)).rejects.toThrow('nonempty');
    await expect(importSessionAudio(library,session,new File([new Uint8Array([1])],'x.exe'),place)).rejects.toThrow('Unsupported');
    mocks.probe.mockResolvedValue({durationMs:null});
    await expect(importSessionAudio(library,session,new File([new Uint8Array([1])],'x.aiff'),place)).rejects.toThrow('decoded');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
