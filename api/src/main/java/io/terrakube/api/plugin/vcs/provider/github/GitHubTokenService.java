package io.terrakube.api.plugin.vcs.provider.github;

import java.net.InetSocketAddress;
import java.net.Proxy;
import java.security.KeyFactory;
import java.security.NoSuchAlgorithmException;
import java.security.PrivateKey;
import java.security.spec.InvalidKeySpecException;
import java.security.spec.PKCS8EncodedKeySpec;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.Date;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.reactive.function.client.WebClient;
import io.terrakube.api.plugin.vcs.provider.GetAccessToken;
import io.terrakube.api.plugin.vcs.provider.exception.TokenException;
import io.terrakube.api.repository.GitHubAppTokenRepository;
import io.terrakube.api.rs.vcs.GitHubAppToken;
import io.terrakube.api.rs.vcs.Vcs;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.SignatureAlgorithm;
import lombok.extern.slf4j.Slf4j;
import reactor.netty.http.client.HttpClient;
import reactor.netty.transport.ProxyProvider;

@Slf4j
@Service
public class GitHubTokenService implements GetAccessToken<GitHubToken> {

    private static final String DEFAULT_ENDPOINT = "https://github.com";
    // Treat a cached token as expired slightly before GitHub actually expires it, so a
    // request never races the real expiry.
    private static final Duration EXPIRY_SAFETY_BUFFER = Duration.ofMinutes(1);

    @Autowired
    ObjectMapper objectMapper;
    @Autowired
    GitHubAppTokenRepository gitHubAppTokenRepository;

    public GitHubToken getAccessToken(String clientId, String clientSecret, String tempCode, String callback,
                                      String endpoint) throws TokenException {
        HttpClient httpClient;
        WebClient client;
        if(System.getProperty("http.proxyHost") != null) {
            log.info("Using proxy host: {} port: {}", System.getProperty("http.proxyHost"), System.getProperty("http.proxyPort"));

            httpClient = HttpClient.create()
                    .proxy(proxy -> proxy.type(ProxyProvider.Proxy.HTTP)
                            .host(System.getProperty("http.proxyHost"))
                            .port(Integer.parseInt(System.getProperty("http.proxyPort"))));

            client = WebClient.builder()
                    .baseUrl((endpoint != null)? endpoint : DEFAULT_ENDPOINT)
                    .defaultHeader(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
                    .clientConnector(new ReactorClientHttpConnector(httpClient))
                    .build();
        } else {
            log.info("No proxy host specified, using default proxy");
            client = WebClient.builder()
                    .baseUrl((endpoint != null)? endpoint : DEFAULT_ENDPOINT)
                    .defaultHeader(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
                    .build();
        }


        log.info("Calling Github API");

        GitHubToken gitHubToken = client.post().uri(uriBuilder -> uriBuilder.path("/login/oauth/access_token")
                        .queryParam("client_id", clientId)
                        .queryParam("client_secret", clientSecret)
                        .queryParam("code", tempCode)
                        .build())
                .retrieve().bodyToMono(GitHubToken.class).block();

        if (gitHubToken != null)
            return gitHubToken;
        else {
            throw new TokenException("500", "Unable to get GitHub Token");
        }
    }

    public String getAccessToken(Vcs vcs, String[] ownerAndRepo)
            throws JsonMappingException, JsonProcessingException, NoSuchAlgorithmException, InvalidKeySpecException {
        return getGitHubAppToken(vcs, ownerAndRepo).getToken();
    }

    // A cached token is served while it is still valid and minted on demand when it is
    // not. Tokens are only worth anything at the moment a caller needs one, and every
    // consumer comes through here, so validating on read covers all of them at once.
    public GitHubAppToken getGitHubAppToken(Vcs vcs, String[] ownerAndRepo)
            throws JsonMappingException, JsonProcessingException, NoSuchAlgorithmException, InvalidKeySpecException {
        log.info("Getting access token for user/organization {} and vcs {}", ownerAndRepo[0], vcs.getId());
        GitHubAppToken gitHubAppToken = gitHubAppTokenRepository.findByAppIdAndOwner(vcs.getClientId(), ownerAndRepo[0]);

        if (gitHubAppToken != null && !isExpired(gitHubAppToken.getExpiresAt())) {
            log.debug("Cached GitHub App token for user/organization {} is still valid", ownerAndRepo[0]);
            return gitHubAppToken;
        }

        if (gitHubAppToken == null) {
            log.info("No token cached for user/organization {}, minting one", ownerAndRepo[0]);
        } else {
            log.info("Cached GitHub App token for user/organization {} is expired or missing an expiry, minting a new one",
                    ownerAndRepo[0]);
        }
        return mintAndCacheToken(vcs, ownerAndRepo, gitHubAppToken);
    }

    // Mints an installation token and upserts the cache row.
    //
    // The installation is resolved on every mint rather than read back from the cached
    // row. An installation id is not stable - reinstalling an app, or installing it on
    // another account, issues new ids - and a cached id that GitHub no longer accepts
    // leaves that owner permanently broken, since nothing would ever reconsider it.
    private GitHubAppToken mintAndCacheToken(Vcs vcs, String[] ownerAndRepo, GitHubAppToken cached)
            throws NoSuchAlgorithmException, InvalidKeySpecException, JsonProcessingException {
        String owner = ownerAndRepo[0];
        String jws = generateJWT(vcs.getClientId(), vcs.getPrivateKey());
        String installationId = resolveInstallationId(vcs.getApiUrl(), jws, ownerAndRepo);
        GitHubAppInstallationToken installationToken = fetchGitHubAppInstallationToken(installationId, vcs.getApiUrl(),
                jws, owner);

        if (installationToken.token() == null) {
            // Caching a row with no token would poison it: later reads would find the
            // row, hand back a null token, and the clone would go out unauthenticated -
            // reaching the user as an unexplained "not authorized" from the git client.
            throw new IllegalStateException(String.format(
                    "Installation %s of GitHub App %s returned no token for user/organization %s", installationId,
                    vcs.getClientId(), owner));
        }

        GitHubAppToken gitHubAppToken = cached != null ? cached : new GitHubAppToken();
        gitHubAppToken.setOwner(owner);
        gitHubAppToken.setAppId(vcs.getClientId());
        gitHubAppToken.setInstallationId(installationId);
        gitHubAppToken.setToken(installationToken.token());
        gitHubAppToken.setExpiresAt(installationToken.expiresAt());
        gitHubAppToken = gitHubAppTokenRepository.save(gitHubAppToken);

        log.info("Token minted for user/organization {} on installation {}, expires at {}", owner, installationId,
                installationToken.expiresAt());
        return gitHubAppToken;
    }

    // Which installation of the app serves this repository. An account holds at most one
    // installation of a given app, so this identifies the owner's installation too - and
    // unlike the owner-level endpoints it also proves the repository is within that
    // installation's scope, which is what the caller is about to rely on.
    private String resolveInstallationId(String vcsApiUrl, String jws, String[] ownerAndRepo)
            throws JsonProcessingException {
        if (ownerAndRepo.length < 2 || ownerAndRepo[1] == null || ownerAndRepo[1].isBlank()) {
            throw new IllegalArgumentException(
                    "A repository is required to resolve the GitHub App installation for owner " + ownerAndRepo[0]);
        }
        String url = vcsApiUrl + "/repos/" + ownerAndRepo[0] + "/" + ownerAndRepo[1] + "/installation";
        log.info("Resolving the GitHub App installation for user/organization {} using url {}", ownerAndRepo[0], url);
        ResponseEntity<String> response = callGithubAPI("", url, HttpMethod.GET, jws);
        String installationId = objectMapper.readTree(response.getBody()).path("id").asText();
        if (installationId.isBlank()) {
            throw new IllegalStateException(
                    "No GitHub App installation id returned for repository " + String.join("/", ownerAndRepo));
        }
        log.info("Resolved installation {} for user/organization {}", installationId, ownerAndRepo[0]);
        return installationId;
    }

    // Gets the access token with app installation ID for a specific installation of
    // the app
    private GitHubAppInstallationToken fetchGitHubAppInstallationToken(String installationId, String vcsApiUrl,
            String jws, String owner) throws JsonProcessingException {
        String token = null;
        Instant expiresAt = null;
        String url = vcsApiUrl + "/app/installations/" + installationId + "/access_tokens";
        log.debug("Getting access token for installation {} on user/organization {}", installationId, owner);
        ResponseEntity<String> tokenResponse = callGithubAPI("", url, HttpMethod.POST, jws);
        if (tokenResponse.getStatusCode().value() == 201) {
            JsonNode rootNode = objectMapper.readTree(tokenResponse.getBody());
            token = rootNode.path("token").asText();
            String expiresAtText = rootNode.path("expires_at").asText();
            expiresAt = expiresAtText.isEmpty() ? null : Instant.parse(expiresAtText);
        }
        return new GitHubAppInstallationToken(token, expiresAt);
    }

    // A token with no recorded expiry is treated as expired: rows written before the
    // expiry was tracked must self-heal on the next read rather than being served
    // forever.
    private boolean isExpired(Instant expiresAt) {
        return expiresAt == null || !expiresAt.isAfter(Instant.now().plus(EXPIRY_SAFETY_BUFFER));
    }

    private record GitHubAppInstallationToken(String token, Instant expiresAt) {
    }

    // Generates a JWT token for the GitHub App
    private String generateJWT(String clientId, String privateKey)
            throws NoSuchAlgorithmException, InvalidKeySpecException {
        String keyPem = privateKey.replace("-----BEGIN PRIVATE KEY-----", "")
                .replace("-----END PRIVATE KEY-----", "")
                .replaceAll(System.lineSeparator(), "");

        log.debug("Stripped PKCS8 private key starting with {} and ending with {}", keyPem.substring(0, 10),
                keyPem.substring(keyPem.length() - 10));
        PKCS8EncodedKeySpec keySpec = new PKCS8EncodedKeySpec(Base64.getDecoder().decode(keyPem));
        KeyFactory keyFactory = KeyFactory.getInstance("RSA");
        PrivateKey key = keyFactory.generatePrivate(keySpec);

        Instant now = Instant.now();
        String jws = Jwts.builder()
                .setIssuer(clientId)
                .setIssuedAt(Date.from(now))
                .setExpiration(Date.from(now.plus(10, ChronoUnit.MINUTES)))
                .signWith(key, SignatureAlgorithm.RS256)
                .compact();
        return jws;
    }

    // Calls the GitHub API
    private ResponseEntity<String> callGithubAPI(String body, String apiUrl, HttpMethod method, String jws) {
        HttpHeaders headers = new HttpHeaders();
        headers.set("Accept", "application/vnd.github+json");
        headers.set("Authorization", "Bearer " + jws);
        headers.set("X-GitHub-Api-Version", "2022-11-28");
        RestTemplate restTemplate = getRestTemplateWithProxy();
        HttpEntity<String> entity = new HttpEntity<>(body, headers);
        return restTemplate.exchange(apiUrl, method, entity, String.class);
    }

    public RestTemplate getRestTemplateWithProxy() {
        if (System.getProperty("http.proxyHost") != null) {
            log.info("RestTemplate proxy host: {} port: {}", System.getProperty("http.proxyHost"), System.getProperty("http.proxyPort"));
            SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
            String proxyHost = System.getProperty("http.proxyHost");
            int proxyPort = Integer.parseInt(System.getProperty("http.proxyPort"));
            Proxy proxy = new Proxy(Proxy.Type.HTTP, new InetSocketAddress(proxyHost, proxyPort));
            requestFactory.setProxy(proxy);
            return new RestTemplate(requestFactory);
        } else {
            log.info("No proxy setup");
            return new RestTemplate();
        }
    }
}