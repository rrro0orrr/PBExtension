class URLBuilder {
    baseUrl;
    queryParams = {};
    pathSegments = [];
    constructor(baseUrl) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
    }
    formatArrayQuery(key, value) {
        return value.length > 0 ? value.map((v) => `${key}[]=${v}`) : [];
    }
    formatObjectQuery(key, value) {
        return Object.entries(value)
            .map(([objKey, objValue]) => objValue !== undefined ? `${key}[${objKey}]=${objValue}` : undefined)
            .filter((x) => x !== undefined);
    }
    formatQuery(queryParams) {
        return Object.entries(queryParams)
            .flatMap(([key, value]) => {
            // Handle string[]
            if (Array.isArray(value)) {
                return this.formatArrayQuery(key, value);
            }
            // Handle objects
            if (typeof value === "object") {
                return this.formatObjectQuery(key, value);
            }
            // Default handling
            return value === "" ? [] : [`${key}=${value}`];
        })
            .join("&");
    }
    build() {
        const fullPath = this.pathSegments.length > 0 ? `/${this.pathSegments.join("/")}` : "";
        const queryString = this.formatQuery(this.queryParams);
        if (queryString.length > 0)
            return `${this.baseUrl}${fullPath}?${queryString}`;
        return `${this.baseUrl}${fullPath}`;
    }
    addPath(segment, encode = false) {
        const trimmed = segment.replace(/^\/+|\/+$/g, "");
        this.pathSegments.push(encode ? encodeURIComponent(trimmed) : trimmed);
        return this;
    }
    addQuery(key, value) {
        this.queryParams[key] = value;
        return this;
    }
    reset() {
        this.queryParams = {};
        this.pathSegments = [];
        return this;
    }
}
export { URLBuilder };
