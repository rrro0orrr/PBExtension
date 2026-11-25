import { URLBuilder as BaseURLBuilder } from "./base";
class URLBuilder extends BaseURLBuilder {
    formatArrayQuery(key, value) {
        return value.length > 0 ? value.map((v) => `${key}=${v}`) : [];
    }
}
export { URLBuilder };
