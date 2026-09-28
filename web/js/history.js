/*
 * MapMap Web - undo / redo history (replaces QUndoStack + src/core/Commands.cpp).
 * Each entry is a snapshot of the model taken after an action.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

export class History {
  constructor(limit = 150) {
    this.limit = limit;
    this.states = [];
    this.index = -1;
  }

  reset(state) {
    this.states = [{ ...state, time: Date.now() }];
    this.index = 0;
  }

  push(state, mergeKey = null) {
    this.states.length = this.index + 1;
    const top = this.states[this.index];
    const now = Date.now();
    if (mergeKey && top && top.mergeKey === mergeKey && now - top.time < 1500 && this.index > 0) {
      this.states[this.index] = { ...state, mergeKey, time: now };
      return;
    }
    this.states.push({ ...state, mergeKey, time: now });
    if (this.states.length > this.limit) this.states.shift();
    this.index = this.states.length - 1;
  }

  canUndo() { return this.index > 0; }
  canRedo() { return this.index < this.states.length - 1; }

  undo() {
    if (!this.canUndo()) return null;
    const undone = this.states[this.index];
    this.index--;
    return { state: this.states[this.index], label: undone.label };
  }

  redo() {
    if (!this.canRedo()) return null;
    this.index++;
    const s = this.states[this.index];
    return { state: s, label: s.label };
  }

  get undoLabel() { return this.canUndo() ? this.states[this.index].label : null; }
  get redoLabel() { return this.canRedo() ? this.states[this.index + 1].label : null; }
}
