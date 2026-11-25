/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */
/**
 * State management utility for form values
 * Handles in-memory form updating
 */
export class State {
    form;
    _stateKey;
    _value;
    get value() {
        return this._value;
    }
    /**
     * Returns selector for binding to form elements
     */
    get selector() {
        return Application.Selector(this, "updateValue");
    }
    constructor(form, _stateKey, value) {
        this.form = form;
        this._stateKey = _stateKey;
        this._value = value;
    }
    /**
     * Updates state value and refreshes the form
     */
    async updateValue(value) {
        this._value = value;
        this.form.reloadForm();
    }
}
