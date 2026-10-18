// PipeWire < 1.0 headers (e.g. Ubuntu 22.04's libspa-0.2-dev 0.3.48) expose
// spa_meta_first and spa_meta_region_is_valid as plain macros, so bindgen in
// libspa-sys emits no symbols for them. Wrap the macros in real functions;
// the Rust side routes to these when the `spa_meta_macros` cfg is set.
#include <stdbool.h>
#include <spa/buffer/meta.h>

void *pwrs_spa_meta_first(const struct spa_meta *m) {
    return spa_meta_first(m);
}

bool pwrs_spa_meta_region_is_valid(const struct spa_meta_region *m) {
    return spa_meta_region_is_valid(m);
}
