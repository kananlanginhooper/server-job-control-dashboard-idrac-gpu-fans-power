var e={id:"",apiBase:"api/"};function i(t){e=t}var n=t=>e.id?`${e.id}.${t}`:t,r=(t,o)=>o(t.url.startsWith("/api/")?t.clone({url:e.apiBase+t.url.slice(5)}):t);export{i as a,n as b,r as c};
