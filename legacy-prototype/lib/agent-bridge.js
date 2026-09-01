// Agent Bridge — handles agent-to-agent delegation

const db = require('./db');

class AgentBridge {
  constructor(agentManager, io) {
    this.agentManager = agentManager;
    this.io = io;
  }

  /**
   * Handle a delegation request from one agent to another.
   * Streams the target agent's response back and injects it
   * into the source agent's conversation.
   */
  async handleDelegation(sourceAgentName, targetAgentName, message, socketId) {
    const source = this.agentManager.get(sourceAgentName);
    const target = this.agentManager.get(targetAgentName);

    if (!target) {
      const err = `Delegation failed: agent "${targetAgentName}" not found`;
      this._emit(socketId, 'delegation:error', { source: sourceAgentName, error: err });
      return err;
    }

    // Notify UI that delegation is happening
    this._emit(socketId, 'delegation:start', {
      source: sourceAgentName,
      target: targetAgentName,
      message,
    });

    // Update statuses
    this.agentManager.setStatus(sourceAgentName, 'thinking');
    this.agentManager.setStatus(targetAgentName, 'working');
    this._broadcastState();

    // Build a delegation prompt
    const delegationMessage = `[Request from ${sourceAgentName} (${source?.role || 'Agent'})]: ${message}`;

    // Stream the target agent's response
    let fullResponse = '';

    try {
      for await (const chunk of this.agentManager.chat(targetAgentName, delegationMessage)) {
        if (chunk.type === 'token') {
          fullResponse += chunk.text;
          this._emit(socketId, 'delegation:token', {
            source: sourceAgentName,
            target: targetAgentName,
            text: chunk.text,
          });
        }
      }
    } catch (err) {
      const errMsg = `Delegation error: ${err.message}`;
      this._emit(socketId, 'delegation:error', { source: sourceAgentName, error: errMsg });
      this.agentManager.setStatus(sourceAgentName, 'idle');
      this._broadcastState();
      return errMsg;
    }

    // Inject the response back into the source agent's conversation
    if (source) {
      source.messages.push({
        role: 'user',
        content: `[Response from ${targetAgentName}]: ${fullResponse}`,
      });
    }

    // Save delegation messages
    db.addMessage(targetAgentName, 'user', delegationMessage);
    db.addMessage(targetAgentName, 'assistant', fullResponse);

    // Notify completion
    this._emit(socketId, 'delegation:done', {
      source: sourceAgentName,
      target: targetAgentName,
      response: fullResponse,
    });

    this.agentManager.setStatus(sourceAgentName, 'idle');
    this._broadcastState();

    return fullResponse;
  }

  _emit(socketId, event, data) {
    if (this.io && socketId) {
      this.io.to(socketId).emit(event, data);
    }
  }

  _broadcastState() {
    if (this.io) {
      this.io.emit('state', this.agentManager.getState());
    }
  }
}

module.exports = AgentBridge;
