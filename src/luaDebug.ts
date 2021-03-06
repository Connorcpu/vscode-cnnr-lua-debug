/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import {
    DebugSession,
    InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent, Event,
    Thread, StackFrame, Scope, Source, Handles, Breakpoint
} from 'vscode-debugadapter';
import {DebugProtocol} from 'vscode-debugprotocol';
import {readFileSync} from 'fs';
import {basename} from 'path';
import {spawn, ChildProcess} from 'child_process';
import * as path from 'path';
import * as readline from 'readline';

let e = null;
let mipc;
try
{
    const ffi = require('ffi');
    /*const ref = require('ref');

    const pIpcClient = ref.refType(ref.types.void);
    const rString = ref.refType(ref.types.char);
    const pString = ref.refType(rString);
    const pSize = ref.refType(ref.types.size_t);

    mipc = ffi.Library(`${process.env.CONNORLIB_HOME}/bin/x64/messageipc.dll`, {
        'mipc_open_server': [ pIpcClient, [ 'string' ] ],
        'mipc_open_client': [ pIpcClient, [ 'string', ref.types.uint ] ],
        'mipc_close': [ ref.types.void, [ pIpcClient ] ],
        'mipc_send': [ 'int', [ pIpcClient, 'string', ref.types.uint ] ],
        'mipc_recv': [ 'int', [ pIpcClient, pString, pSize ] ],
        'mipc_try_recv': [ 'int', [ pIpcClient, pString, pSize ] ],
        'mipc_recv_free': [ ref.types.void, [ rString, ref.types.size_t ] ],
    });*/
}
catch (ex)
{
    e = ex;
}

/**
 * This interface should always match the schema found in the mock-debug extension manifest.
 */
export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    /** An absolute path to the program to debug. */
    program: string;
    /** Automatically stop target after launch. If not specified, target does not stop. */
    stopOnEntry?: boolean;
}

class MockDebugSession extends DebugSession {

    // we don't support multiple threads, so we can use a hardcoded ID for the default thread
    private static THREAD_ID = 1;

    // since we want to send breakpoint events, we will assign an id to every event
    // so that the frontend can match events with breakpoints.
    private _breakpointId = 1000;

    // This is the next line that will be 'executed'
    private __currentLine = 0;
    private get _currentLine() : number {
        return this.__currentLine;
    }
    private set _currentLine(line: number) {
        this.__currentLine = line;
        this.sendEvent(new OutputEvent(`line: ${line}\n`));    // print current line on debug console
    }

    // the initial (and one and only) file we are 'debugging'
    private _sourceFile: string;

    // the contents (= lines) of the one and only file
    private _sourceLines = new Array<string>();

    // maps from sourceFile to array of Breakpoints
    private _breakPoints = new Map<string, DebugProtocol.Breakpoint[]>();

    private _variableHandles = new Handles<string>();

    private _timer;

    private _dbgProc: ChildProcess;


    /**
     * Creates a new debug adapter that is used for one debug session.
     * We configure the default implementation of a debug adapter here.
     */
    public constructor() {
        super();

        // this debugger uses zero-based lines and columns
        this.setDebuggerLinesStartAt1(false);
        this.setDebuggerColumnsStartAt1(false);
    }

    /**
     * The 'initialize' request is the first request called by the frontend
     * to interrogate the features the debug adapter provides.
     */
    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        // since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
        // we request them early by sending an 'initializeRequest' to the frontend.
        // The frontend will end the configuration sequence by calling 'configurationDone' request.
        this.sendEvent(new InitializedEvent());

        // This debug adapter implements the configurationDoneRequest.
        response.body.supportsConfigurationDoneRequest = true;

        // make VS Code to use 'evaluate' when hovering over source
        response.body.supportsEvaluateForHovers = true;

        // make VS Code to show a 'step back' button
        response.body.supportsStepBack = true;

        this.sendResponse(response);
    }

    protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {
        if (e != null) {
            this.sendEvent(new OutputEvent(`${e}\n`));
        }

        this.sendEvent(new OutputEvent(`${path.parse(args.program).dir}\n`));
        //this._dbgProc = spawn("")
		let rl = readline.createInterface(this._dbgProc.stdout, this._dbgProc.stdin);

        if (args.stopOnEntry) {
            this._currentLine = 0;
            this.sendResponse(response);

            // we stop on the first line
            this.sendEvent(new StoppedEvent("entry", MockDebugSession.THREAD_ID));
        } else {
            // we just start to run until we hit a breakpoint or an exception
            this.continueRequest(<DebugProtocol.ContinueResponse>response, { threadId: MockDebugSession.THREAD_ID });
        }
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
        // stop sending custom events
        clearInterval(this._timer);
        super.disconnectRequest(response, args);
    }

    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

        var path = args.source.path.replace(/\\/g, "/");
        var clientLines = args.lines;

        this.sendEvent(new OutputEvent(`path: ${path}\n`));

        // read file contents into array for direct access
        var lines = readFileSync(path).toString().split('\n');

        var breakpoints = new Array<Breakpoint>();

        // verify breakpoint locations
        for (var i = 0; i < clientLines.length; i++) {
            var l = this.convertClientLineToDebugger(clientLines[i]);
            var verified = false;
            if (l < lines.length) {
                const line = lines[l].trim();
                // if a line is empty or starts with '+' we don't allow to set a breakpoint but move the breakpoint down
                if (line.length == 0 || line.indexOf("+") == 0)
                    l++;
                // if a line starts with '-' we don't allow to set a breakpoint but move the breakpoint up
                if (line.indexOf("-") == 0)
                    l--;
                // don't set 'verified' to true if the line contains the word 'lazy'
                // in this case the breakpoint will be verified 'lazy' after hitting it once.
                if (line.indexOf("lazy") < 0) {
                    verified = true;    // this breakpoint has been validated
                }
            }
            const bp = <DebugProtocol.Breakpoint> new Breakpoint(verified, this.convertDebuggerLineToClient(l));
            bp.id = this._breakpointId++;
            breakpoints.push(bp);
        }
        this._breakPoints.set(path, breakpoints);

        // send back the actual breakpoint positions
        response.body = {
            breakpoints: breakpoints
        };
        this.sendResponse(response);
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

        // return the default thread
        response.body = {
            threads: [
                new Thread(MockDebugSession.THREAD_ID, "thread 1")
            ]
        };
        this.sendResponse(response);
    }

	protected readFromDbg(cb: Function): any {
		this._dbgProc.stdout;
	}

    protected sendToDbg(data: any): void {
		let msg = JSON.stringify(data);
		let len = msg.length;
		msg = len.toString() + "\n" + msg;

		this._dbgProc.stdin.write(msg);
    }

    /**
     * Returns a fake 'stacktrace' where every 'stackframe' is a word from the current line.
     */
    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {

        const words = this._sourceLines[this._currentLine].trim().split(/\s+/);

        const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
        const maxLevels = typeof args.levels === 'number' ? args.levels : words.length-startFrame;
        const endFrame = Math.min(startFrame + maxLevels, words.length);

        const frames = new Array<StackFrame>();
        // every word of the current line becomes a stack frame.
        for (let i= startFrame; i < endFrame; i++) {
            const name = words[i];    // use a word of the line as the stackframe name
            frames.push(new StackFrame(i, `${name}(${i})`, new Source(basename(this._sourceFile),
                this.convertDebuggerPathToClient(this._sourceFile)),
                this.convertDebuggerLineToClient(this._currentLine), 0));
        }
        response.body = {
            stackFrames: frames,
            totalFrames: words.length
        };
        this.sendResponse(response);
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

        const frameReference = args.frameId;
        const scopes = new Array<Scope>();
        scopes.push(new Scope("Local", this._variableHandles.create("local_" + frameReference), false));
        scopes.push(new Scope("Closure", this._variableHandles.create("closure_" + frameReference), false));
        scopes.push(new Scope("Global", this._variableHandles.create("global_" + frameReference), true));

        response.body = {
            scopes: scopes
        };
        this.sendResponse(response);
    }

    protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {

        const variables = [];
        const id = this._variableHandles.get(args.variablesReference);
        if (id != null) {
            variables.push({
                name: id + "_i",
                type: "integer",
                value: "123",
                variablesReference: 0
            });
            variables.push({
                name: id + "_f",
                type: "float",
                value: "3.14",
                variablesReference: 0
            });
            variables.push({
                name: id + "_s",
                type: "string",
                value: "hello world",
                variablesReference: 0
            });
            variables.push({
                name: id + "_o",
                type: "object",
                value: "Object",
                variablesReference: this._variableHandles.create("object_")
            });
        }

        response.body = {
            variables: variables
        };
        this.sendResponse(response);
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {

        // find the breakpoints for the current source file
        const breakpoints = this._breakPoints.get(this._sourceFile);

        for (var ln = this._currentLine+1; ln < this._sourceLines.length; ln++) {

            if (breakpoints) {
                const bps = breakpoints.filter(bp => bp.line === this.convertDebuggerLineToClient(ln));
                if (bps.length > 0) {
                    this._currentLine = ln;

                    // 'continue' request finished
                    this.sendResponse(response);

                    // send 'stopped' event
                    this.sendEvent(new StoppedEvent("breakpoint", MockDebugSession.THREAD_ID));

                    // the following shows the use of 'breakpoint' events to update properties of a breakpoint in the UI
                    // if breakpoint is not yet verified, verify it now and send a 'breakpoint' update event
                    if (!bps[0].verified) {
                        bps[0].verified = true;
                        this.sendEvent(new BreakpointEvent("update", bps[0]));
                    }
                    return;
                }
            }

            // if word 'exception' found in source -> throw exception
            if (this._sourceLines[ln].indexOf("exception") >= 0) {
                this._currentLine = ln;
                this.sendResponse(response);
                this.sendEvent(new StoppedEvent("exception", MockDebugSession.THREAD_ID));
                this.sendEvent(new OutputEvent(`exception in line: ${ln}\n`, 'stderr'));
                return;
            }
        }
        this.sendResponse(response);
        // no more lines: run to end
        this.sendEvent(new TerminatedEvent());
    }

    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {

        for (let ln = this._currentLine+1; ln < this._sourceLines.length; ln++) {
            if (this._sourceLines[ln].trim().length > 0) {   // find next non-empty line
                this._currentLine = ln;
                this.sendResponse(response);
                this.sendEvent(new StoppedEvent("step", MockDebugSession.THREAD_ID));
                return;
            }
        }
        this.sendResponse(response);
        // no more lines: run to end
        this.sendEvent(new TerminatedEvent());
    }

    protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {

        for (let ln = this._currentLine-1; ln >= 0; ln--) {
            if (this._sourceLines[ln].trim().length > 0) {   // find next non-empty line
                this._currentLine = ln;
                this.sendResponse(response);
                this.sendEvent(new StoppedEvent("step", MockDebugSession.THREAD_ID));
                return;
            }
        }
        this.sendResponse(response);
    }

    protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {

        response.body = {
            result: `evaluate(context: '${args.context}', '${args.expression}')`,
            variablesReference: 0
        };
        this.sendResponse(response);
    }
}

DebugSession.run(MockDebugSession);
